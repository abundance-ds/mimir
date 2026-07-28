<template>
  <BusinessGraphApp
    v-if="surface === 'business-graph'"
    ref="surfaceRef"
    :workspace-path="activity.workspacePath || ''"
    :active="active"
    @open-file="$emit('openFile', $event)"
    @choose-workspace="$emit('chooseWorkspace')"
    @open-activity="$emit('openActivity', $event)"
    @start-work="$emit('startWork', $event)"
    @diagnostic="$emit('diagnostic', $event)"
  />
  <TodayApp
    v-else-if="surface === 'today'"
    ref="surfaceRef"
    :app="app"
    :instance-id="instanceId"
    :active="active"
    @diagnostic="$emit('diagnostic', $event)"
  />
  <EmbeddedAppHost
    v-else-if="surface === 'embedded'"
    ref="surfaceRef"
    :app="app"
    :launch="plan"
    :workspace-path="activity.workspacePath || ''"
    :instance-id="instanceId"
    :active="active"
    @open-file="$emit('openFile', $event)"
    @diagnostic="$emit('diagnostic', $event)"
  />
  <LaunchPlanHost
    v-else-if="surface === 'launch'"
    :app="app"
    :plan="plan"
    :activity="activity"
    :active="active"
    @launch-plan="$emit('launchPlan', $event)"
    @diagnostic="$emit('diagnostic', $event)"
  />
  <section
    v-else
    data-app-activity-invalid
    class="grid h-full place-items-center bg-chrome-high px-8 text-center text-ink"
  >
    <div class="max-w-sm">
      <IconAlertTriangle :size="22" :stroke-width="1.5" class="mx-auto text-rem" />
      <p class="mt-3 text-[12px] font-semibold">{{ activity.title || 'App' }} cannot open</p>
      <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
        {{ invalidReason }}
      </p>
    </div>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import { IconAlertTriangle } from '@tabler/icons-vue'
import BusinessGraphApp from '../apps/BusinessGraphApp.vue'
import TodayApp from '../apps/TodayApp.vue'
import EmbeddedAppHost from '../apps/EmbeddedAppHost.vue'
import LaunchPlanHost from '../apps/LaunchPlanHost.vue'

const props = defineProps({
  activity: { type: Object, required: true },
  active: { type: Boolean, default: false },
})

defineEmits([
  'openFile',
  'openActivity',
  'startWork',
  'chooseWorkspace',
  'launchPlan',
  'diagnostic',
])

const surfaceRef = ref(null)

function focusEntry() {
  surfaceRef.value?.focusEntry?.()
}

function todayState() {
  return surface.value === 'today'
    ? surfaceRef.value?.todayState?.() || null
    : null
}

defineExpose({ focusEntry, todayState })

const app = computed(() => props.activity?.source?.app || null)
const plan = computed(() => props.activity?.launch?.plan || null)
const instanceId = computed(() => props.activity?.id || (
  app.value?.id ? `app:${app.value.id}` : 'app:unknown'
))
const surface = computed(() => {
  if (!app.value || !plan.value?.mode) return 'invalid'
  if (app.value.id === 'scratch') return 'today'
  if (
    app.value.id === 'business-graph'
    || (plan.value.mode === 'rust-helper' && plan.value.helper === 'business-graph')
  ) return 'business-graph'
  if (plan.value.mode === 'embedded') return 'embedded'
  if (['terminal', 'process', 'window', 'action', 'rust-helper'].includes(plan.value.mode)) {
    return 'launch'
  }
  return 'invalid'
})
const invalidReason = computed(() => {
  if (!app.value) return 'The stored app definition is missing. Reopen it from Apps.'
  if (!plan.value?.mode) return 'The stored launch plan is missing. Reopen it from Apps.'
  return `Launch mode '${plan.value.mode}' is not supported by this build.`
})
</script>
