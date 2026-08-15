<template>
  <div class="relative h-full min-h-0 w-full min-w-0 overflow-hidden bg-chrome-high">
    <section
      v-for="activity in mountedActivities"
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

      <div
        v-if="collectionHas(restoringActivityIds, activity.id)"
        :data-activity-restoring="activity.id"
        role="status"
        class="absolute inset-0 z-20 grid place-items-center bg-surface px-8 text-center"
      >
        <p class="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-3">
          Restoring session…
        </p>
      </div>
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
import { computed, ref, watch } from 'vue'

const props = defineProps({
  activities: { type: Array, default: () => [] },
  activeId: { type: String, default: '' },
  restoringActivityIds: { type: [Array, Set], default: () => new Set() },
})

defineEmits(['recover'])

const activeActivity = computed(
  () => props.activities.find((activity) => activity.id === props.activeId) || null,
)

// Creating every xterm surface at startup scales linearly with Activity
// history. Mount on first visit, then retain that surface so its selection,
// viewport, and input state survive switching. Removed/archived Activities
// are released and reconstruct from authoritative native scrollback on return.
const mountedIds = ref([])
watch(
  () => [props.activeId, props.activities.map((activity) => activity.id)],
  ([activeId, availableIds]) => {
    const available = new Set(availableIds)
    const retained = mountedIds.value.filter((id) => available.has(id))
    if (available.has(activeId) && !retained.includes(activeId)) retained.push(activeId)
    mountedIds.value = retained
  },
  { immediate: true },
)
const mountedActivities = computed(() => {
  const mounted = new Set(mountedIds.value)
  return props.activities.filter((activity) => mounted.has(activity.id))
})

function collectionHas(collection, id) {
  return typeof collection?.has === 'function'
    ? collection.has(id)
    : Array.isArray(collection) && collection.includes(id)
}
</script>
