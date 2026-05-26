<template>
  <div class="model-picker">
    <button ref="referenceRef" class="picker-trigger" :disabled="disabled" @click="toggle">
      <component v-if="currentProviderIcon" :is="currentProviderIcon" :size="12" class="picker-provider-icon" />
      <span class="picker-label">{{ currentLabel }}</span>
      <IconChevronDown :size="12" />
    </button>
    <div v-if="isOpen" ref="floatingRef" class="picker-dropdown" :style="floatingStyles">
      <button
        v-for="(model, idx) in flatModels"
        :key="model.id"
        class="picker-option"
        :class="{ selected: model.id === modelId, 'group-start': model._groupStart && idx > 0 }"
        :disabled="model.disabled"
        type="button"
        @click="select(model)"
      >
        <component v-if="providerIconMap[model.provider]" :is="providerIconMap[model.provider]" :size="11" class="option-provider-icon" />
        <span class="option-name">{{ model.displayName || model.name || model.id }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { usePopover } from '../../shared/composables/usePopover'
import { IconChevronDown } from '@tabler/icons-vue'
import IconProviderAnthropic from '../../shared/icons/IconProviderAnthropic.vue'
import IconProviderOpenAI from '../../shared/icons/IconProviderOpenAI.vue'
import IconProviderGoogle from '../../shared/icons/IconProviderGoogle.vue'

const providerIconMap = {
  anthropic: IconProviderAnthropic,
  openai: IconProviderOpenAI,
  google: IconProviderGoogle,
}

const props = defineProps({
  modelId: String,
  models: { type: Array, default: () => [] },
  disabled: Boolean,
})
const emit = defineEmits(['update:modelId'])

const { referenceRef, floatingRef, floatingStyles, isOpen, toggle, close } = usePopover()

const currentLabel = computed(() => {
  const model = props.models.find((item) => item.id === props.modelId)
  return model?.displayName || model?.name || props.modelId || 'Model'
})

const currentProviderIcon = computed(() => {
  const model = props.models.find(m => m.id === props.modelId)
  return providerIconMap[model?.provider] || null
})

const flatModels = computed(() => {
  const providerOrder = ['anthropic', 'google', 'openai']
  const grouped = providerOrder.flatMap((provider) =>
    props.models.filter((model) => model.provider === provider)
  )
  const other = props.models.filter((model) => !providerOrder.includes(model.provider))
  const allOrdered = [...grouped, ...other]

  let lastProvider = null
  return allOrdered.map((model) => {
    const isGroupStart = model.provider !== lastProvider
    lastProvider = model.provider
    return { ...model, _groupStart: isGroupStart }
  })
})

function select(model) {
  if (model.disabled) return
  emit('update:modelId', model.id)
  close()
}
</script>

<style scoped>
.model-picker { position: relative; }
.picker-trigger {
  display: inline-flex; align-items: center; gap: 4px;
  height: 28px; padding: 0 10px;
  border-radius: 999px; color: var(--color-ink-2);
  font-family: var(--font-mono); font-size: 12px;
}
.picker-trigger:hover { background: var(--color-surface); }
.picker-trigger:disabled { opacity: 0.4; pointer-events: none; }
.picker-dropdown {
  background: var(--color-surface); border: 1px solid var(--color-rule); border-radius: 6px;
  padding: 5px; width: 280px; z-index: 20;
  box-shadow: 0 8px 30px rgba(0,0,0,.18);
}
.picker-option {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 7px 10px; border-radius: 4px;
  font-size: 12px; text-align: left;
}
.picker-option.group-start { margin-top: 4px; padding-top: 8px; border-top: 1px solid var(--color-rule-light); }
.picker-option:hover { background: var(--color-chrome-high); }
.picker-option.selected { background: var(--color-accent-tint); color: var(--color-accent); font-weight: 600; }
.picker-option:disabled { opacity: 0.4; cursor: default; }
.picker-option:disabled:hover { background: transparent; }
.option-name { font-family: var(--font-mono); flex-shrink: 0; }
.picker-provider-icon { flex-shrink: 0; color: var(--color-ink-3); }
.option-provider-icon { flex-shrink: 0; color: var(--color-ink-3); }
</style>
