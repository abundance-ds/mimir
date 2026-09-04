<template>
  <section
    data-launch-plan-host
    class="flex h-full min-h-0 flex-col bg-chrome-high text-ink"
  >
    <header data-launch-plan-header class="pane-bar gap-2">
      <component :is="modeIcon" :size="14" :stroke-width="1.7" class="text-ink-3" />
      <span class="text-[11px] font-semibold">{{ app.title }}</span>
      <span class="font-mono text-[8px] uppercase tracking-[0.12em] text-ink-4">
        {{ modeLabel }}
      </span>
      <span
        data-launch-plan-state
        class="ml-auto font-mono text-[8px] uppercase tracking-[0.1em]"
        :class="state === 'error' ? 'text-rem' : state === 'requested' ? 'text-accent' : 'text-ink-4'"
      >
        {{ stateDetail || stateLabel }}
      </span>
    </header>

    <div class="grid min-h-0 flex-1 place-items-center px-8">
      <div class="w-full max-w-lg">
        <p class="font-mono text-[8px] font-semibold uppercase tracking-[0.14em] text-ink-3">
          {{ instruction }}
        </p>
        <div class="mt-3 border border-rule bg-surface">
          <div class="flex min-h-11 items-center border-b border-rule-light px-3">
            <span class="w-20 shrink-0 font-mono text-[8px] uppercase tracking-[0.1em] text-ink-4">
              {{ primaryLabel }}
            </span>
            <code class="min-w-0 break-all font-mono text-[10px] text-ink-2">{{ primaryValue }}</code>
          </div>
          <div v-if="secondaryValue" class="flex min-h-10 items-center px-3">
            <span class="w-20 shrink-0 font-mono text-[8px] uppercase tracking-[0.1em] text-ink-4">
              {{ secondaryLabel }}
            </span>
            <code class="min-w-0 break-all font-mono text-[9px] text-ink-3">{{ secondaryValue }}</code>
          </div>
        </div>

        <p
          v-if="state === 'idle' && activity.status === 'interrupted'"
          class="mt-3 text-[10px] leading-relaxed text-ink-3"
        >
          This Activity was restored without replaying its external side effect.
        </p>
        <p v-else-if="state === 'requested'" class="mt-3 text-[10px] leading-relaxed text-ink-3">
          The launch request is with the workbench runtime. This Activity stays available for diagnostics and relaunch.
        </p>
        <p
          v-if="error"
          data-launch-plan-error
          role="alert"
          class="mt-3 border-l-2 border-rem bg-rem/5 px-3 py-2 text-[10px] text-rem"
        >
          {{ error }}
        </p>

        <button
          ref="runButton"
          type="button"
          data-launch-plan-run
          class="mt-4 flex h-8 items-center gap-2 border border-rule px-3 text-[10px] font-semibold hover:border-accent/50 hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="dispatch"
        >
          <IconPlayerPlay :size="13" :stroke-width="1.7" />
          {{ state === 'idle' ? actionLabel : 'Launch again' }}
        </button>
      </div>
    </div>

    <footer data-launch-plan-footer class="pane-footer px-3">
      <span>{{ app.id }}</span>
      <span class="ml-auto">{{ activity.workspacePath || 'app directory' }}</span>
    </footer>
  </section>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import {
  IconBolt,
  IconExternalLink,
  IconPlayerPlay,
  IconTerminal2,
  IconTool,
  IconWindow,
} from '@tabler/icons-vue'

const props = defineProps({
  app: { type: Object, required: true },
  plan: { type: Object, required: true },
  activity: { type: Object, required: true },
  active: { type: Boolean, default: false },
})

const emit = defineEmits(['launchPlan', 'diagnostic'])
const runButton = ref(null)
const state = ref('idle')
const stateDetail = ref('')
const error = ref('')
let autoDispatched = false

const modeLabel = computed(() => ({
  terminal: 'Terminal preset',
  process: 'Local process',
  window: 'App window',
  action: 'Tool action',
  'rust-helper': 'Native helper',
}[props.plan.mode] || props.plan.mode || 'Unknown'))
const modeIcon = computed(() => ({
  terminal: IconTerminal2,
  process: IconTool,
  window: IconWindow,
  action: IconBolt,
  'rust-helper': IconExternalLink,
}[props.plan.mode] || IconPlayerPlay))
const instruction = computed(() => ({
  terminal: 'Open as a terminal Activity',
  process: props.plan.launchOnly ? 'Launch detached process' : 'Launch managed process',
  window: 'Open in its own window',
  action: 'Call registered tool',
  'rust-helper': 'Start native helper',
}[props.plan.mode] || 'Hand off launch plan'))
const primaryLabel = computed(() => ({
  terminal: 'Preset',
  process: 'Command',
  window: 'URL',
  action: 'Tool',
  'rust-helper': 'Helper',
}[props.plan.mode] || 'Plan'))
const primaryValue = computed(() => {
  if (props.plan.mode === 'terminal') return joinCommand(props.plan.preset, props.plan.args)
  if (props.plan.mode === 'process') return joinCommand(props.plan.command, props.plan.args)
  return props.plan.url || props.plan.tool || props.plan.helper || 'Unknown launch target'
})
const secondaryLabel = computed(() => props.plan.mode === 'process' ? 'Working dir' : 'App')
const secondaryValue = computed(() => (
  props.plan.mode === 'process' ? props.plan.cwd : props.plan.appId
))
const actionLabel = computed(() => ({
  terminal: 'Open terminal',
  process: 'Start process',
  window: 'Open window',
  action: 'Run action',
  'rust-helper': 'Start helper',
}[props.plan.mode] || 'Launch'))
const stateLabel = computed(() => ({
  idle: 'Ready',
  requested: 'Requested',
  running: 'Running',
  complete: 'Complete',
  error: 'Failed',
}[state.value] || state.value))

watch(() => props.active, async (active) => {
  if (!active) return
  if (!autoDispatched && props.activity.status === 'ready') {
    autoDispatched = true
    dispatch()
  }
  await nextTick()
  runButton.value?.focus()
}, { immediate: true })

function dispatch() {
  error.value = ''
  state.value = 'requested'
  stateDetail.value = ''
  emit('launchPlan', {
    app: props.app,
    plan: props.plan,
    activity: props.activity,
    onStarted(detail = {}) {
      state.value = 'running'
      stateDetail.value = String(detail.label || detail.activityId || '')
    },
    onComplete(detail = {}) {
      state.value = 'complete'
      stateDetail.value = String(detail.label || '')
    },
    onError(cause) {
      error.value = errorMessage(cause)
      state.value = 'error'
      stateDetail.value = ''
      emit('diagnostic', error.value)
    },
  })
}

function joinCommand(command, args = []) {
  return [command, ...(Array.isArray(args) ? args : [])]
    .filter((part) => part != null && String(part))
    .map((part) => String(part))
    .join(' ')
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause || 'Launch failed.')
}
</script>
