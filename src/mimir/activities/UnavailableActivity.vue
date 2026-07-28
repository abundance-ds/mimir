<template>
  <div class="grid h-full min-h-0 place-items-center bg-chrome-high px-8 text-center text-ink">
    <div class="max-w-sm">
      <IconAlertTriangle :size="22" :stroke-width="1.5" class="mx-auto text-rem" />
      <p class="mt-3 text-[12px] font-semibold">{{ activity.title }}</p>
      <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
        {{ message }}
      </p>
      <button
        v-if="canStop"
        type="button"
        data-unavailable-stop
        class="mt-4 h-8 border border-rule px-3 text-[10px] font-semibold text-ink-2 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        @click="$emit('requestStop', activity.id)"
      >
        Stop Activity
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { IconAlertTriangle } from '@tabler/icons-vue'

const props = defineProps({
  activity: { type: Object, required: true },
  diagnostic: { type: String, default: '' },
})

defineEmits(['requestStop'])

const canStop = computed(() => (
  ['terminal', 'agent'].includes(props.activity.kind)
  && ['ready', 'starting', 'working', 'needs-input', 'idle'].includes(props.activity.status)
))

const message = computed(() => {
  if (props.diagnostic) return props.diagnostic
  if (['terminal', 'agent'].includes(props.activity.kind)) {
    return 'The terminal renderer could not be loaded. The process remains supervised and can be stopped safely.'
  }
  return `The ${props.activity.kind} surface could not be loaded. Check its local definition and restart Mimir.`
})
</script>
