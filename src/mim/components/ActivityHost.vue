<template>
  <div class="relative h-full min-h-0 w-full min-w-0 overflow-hidden bg-chrome-high">
    <section
      v-for="activity in activities"
      :key="activity.id"
      :data-activity-surface="activity.id"
      class="absolute inset-0 min-h-0 min-w-0 overflow-hidden"
      :class="{ 'pointer-events-none invisible': activity.id !== activeId }"
      :aria-hidden="activity.id !== activeId"
    >
      <slot :name="`activity-${activity.id}`" :activity="activity">
        <div class="grid h-full place-items-center px-8 text-center">
          <div>
            <p class="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-3">
              {{ activity.title }}
            </p>
            <p class="mt-2 text-[11px] text-ink-2">This Activity has no compatible surface.</p>
          </div>
        </div>
      </slot>
    </section>

    <div
      v-if="!activeActivity"
      data-activity-missing
      class="grid h-full place-items-center px-8 text-center"
    >
      <div class="max-w-xs">
        <p class="font-mono text-[10px] uppercase tracking-[0.14em] text-rem">
          Activity unavailable
        </p>
        <p class="mt-2 text-[12px] leading-relaxed text-ink-2">
          {{ activeId || 'The selected Activity' }} is missing or could not be restored.
        </p>
        <button
          type="button"
          data-activity-recover
          class="mt-4 h-8 border border-rule px-3 text-[10px] font-semibold text-ink-2 hover:bg-chrome hover:text-ink"
          @click="$emit('recover')"
        >
          Open Files
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  activities: { type: Array, default: () => [] },
  activeId: { type: String, default: '' },
})

defineEmits(['recover'])

const activeActivity = computed(
  () => props.activities.find((activity) => activity.id === props.activeId) || null,
)
</script>
