<template>
  <span
    :class="rail ? 'activity-status-rail' : 'inline-flex items-center gap-[6px] lowercase tabular-nums tracking-normal'"
  >
    <WorkingIndicator
      v-if="state === 'working' || state === 'starting'"
      :data-activity-working="activityId"
      :label="state === 'starting' ? 'Starting' : 'Working'"
      :paused="paused"
    />
    <template v-else>
      <span
        v-if="state === 'error' || state === 'attention' || state === 'unread'"
        :data-activity-error="state === 'error' ? activityId : undefined"
        :data-activity-attention="state === 'attention' ? activityId : undefined"
        :data-activity-unread="state === 'unread' ? activityId : undefined"
        :aria-label="label"
        :title="label"
        role="img"
        class="size-[6px] shrink-0 rounded-full"
        :class="state === 'error' ? 'bg-rem' : state === 'attention' ? 'bg-attn/65' : 'bg-info/60'"
      />
      <span v-if="!rail" data-activity-time>{{ time }}</span>
    </template>
  </span>
</template>

<script setup>
import { computed } from 'vue'
import WorkingIndicator from './WorkingIndicator.vue'

const props = defineProps({
  activityId: { type: String, required: true },
  state: { type: String, required: true },
  time: { type: String, default: '' },
  rail: Boolean,
  paused: Boolean,
})
const label = computed(() => ({ error: 'Error', attention: 'Needs input', unread: 'Unread' }[props.state] || ''))
</script>

<style scoped>
.activity-status-rail {
  display: grid;
  width: 13px;
  height: 13px;
  place-items: end;
  pointer-events: none;
}
.activity-status-rail :deep(.working-indicator) {
  transform: scale(.55);
  transform-origin: bottom right;
}
</style>
