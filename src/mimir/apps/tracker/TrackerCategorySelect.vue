<template>
  <button
    ref="trigger"
    type="button"
    role="combobox"
    aria-haspopup="listbox"
    :aria-label="ariaLabel"
    :aria-expanded="open"
    :aria-controls="open ? listboxId : undefined"
    :aria-activedescendant="open && activeOption ? optionId(activeOption) : undefined"
    data-tracker-category-trigger
    class="flex h-7 w-full min-w-0 items-center justify-between gap-1.5 border border-rule bg-surface px-2 text-left text-[10px] font-medium text-ink-2 hover:bg-chrome-high hover:text-ink focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    @click="toggle"
    @keydown="onTriggerKeydown"
  >
    <span class="min-w-0 flex-1 truncate">{{ modelValue }}</span>
    <IconChevronDown
      :size="11"
      class="shrink-0 text-ink-4 transition-transform motion-reduce:transition-none"
      :class="{ 'rotate-180': open }"
    />
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      :id="listboxId"
      ref="menu"
      role="listbox"
      :aria-label="ariaLabel"
      class="fixed z-[260] overflow-hidden border border-rule bg-surface p-1 text-ink shadow-lg"
      :style="menuStyle"
      @keydown="onMenuKeydown"
    >
      <button
        v-for="(option, index) in options"
        :id="optionId(option)"
        :key="option"
        :ref="element => setOptionRef(element, index)"
        type="button"
        role="option"
        :aria-selected="option === modelValue"
        :data-tracker-category-option="option"
        class="flex h-7 w-full items-center gap-2 px-2 text-left text-[10px] text-ink-2 hover:bg-chrome-mid hover:text-ink focus-visible:bg-chrome-mid focus-visible:text-ink focus-visible:outline-none"
        @mouseenter="activeIndex = index"
        @focus="activeIndex = index"
        @click="choose(option)"
      >
        <span
          class="grid size-4 shrink-0 place-items-center border border-rule-light text-transparent"
          :class="option === modelValue ? 'border-accent/50 bg-accent-soft text-accent' : ''"
          aria-hidden="true"
        >
          <IconCheck :size="10" />
        </span>
        <span class="truncate">{{ option }}</span>
      </button>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onUnmounted, ref } from 'vue'
import { IconCheck, IconChevronDown } from '@tabler/icons-vue'

const props = defineProps({
  modelValue: { type: String, required: true },
  options: { type: Array, required: true },
  ariaLabel: { type: String, required: true },
})

const emit = defineEmits(['update:modelValue'])
const trigger = ref(null)
const menu = ref(null)
const optionRefs = ref([])
const open = ref(false)
const activeIndex = ref(0)
const menuStyle = ref({})
const selectId = nextSelectId()
const listboxId = `tracker-category-${selectId}`
const activeOption = computed(() => props.options[activeIndex.value])

async function toggle() {
  if (open.value) {
    close()
    return
  }
  await show()
}

async function show({ last = false } = {}) {
  if (open.value || !props.options.length) return
  open.value = true
  const selected = props.options.indexOf(props.modelValue)
  activeIndex.value = last
    ? props.options.length - 1
    : Math.max(0, selected)
  document.addEventListener('pointerdown', onDocumentPointerDown)
  window.addEventListener('resize', positionMenu)
  window.addEventListener('scroll', positionMenu, true)
  await nextTick()
  positionMenu()
  focusOption(activeIndex.value)
}

function close({ restoreFocus = false } = {}) {
  if (!open.value) return
  open.value = false
  optionRefs.value = []
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  window.removeEventListener('resize', positionMenu)
  window.removeEventListener('scroll', positionMenu, true)
  if (restoreFocus) void nextTick(() => trigger.value?.focus())
}

function choose(option) {
  emit('update:modelValue', option)
  close({ restoreFocus: true })
}

function positionMenu() {
  const rect = trigger.value?.getBoundingClientRect()
  if (!rect) return
  const gap = 3
  const width = Math.max(rect.width, 128)
  const height = props.options.length * 28 + 10
  const spaceBelow = window.innerHeight - rect.bottom - gap
  const openAbove = spaceBelow < height && rect.top > spaceBelow
  const top = openAbove
    ? Math.max(6, rect.top - height - gap)
    : Math.min(window.innerHeight - height - 6, rect.bottom + gap)
  const left = Math.min(
    Math.max(6, rect.left),
    Math.max(6, window.innerWidth - width - 6),
  )
  menuStyle.value = {
    top: `${Math.max(6, top)}px`,
    left: `${left}px`,
    width: `${width}px`,
  }
}

function onTriggerKeydown(event) {
  if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return
  event.preventDefault()
  void show({ last: event.key === 'ArrowUp' })
}

function onMenuKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close({ restoreFocus: true })
    return
  }
  if (event.key === 'Tab') {
    event.preventDefault()
    const target = adjacentFocusTarget(event.shiftKey)
    close()
    void nextTick(() => {
      if (target?.isConnected) target.focus()
      else trigger.value?.focus()
    })
    return
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    focusOption(event.key === 'Home' ? 0 : props.options.length - 1)
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const offset = event.key === 'ArrowDown' ? 1 : -1
    focusOption((activeIndex.value + offset + props.options.length) % props.options.length)
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (activeOption.value) choose(activeOption.value)
  }
}

function focusOption(index) {
  if (index < 0 || index >= props.options.length) return
  activeIndex.value = index
  optionRefs.value[index]?.focus()
}

function adjacentFocusTarget(reverse = false) {
  const focusable = [...document.querySelectorAll(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
  )].filter(element => !menu.value?.contains(element))
  const index = focusable.indexOf(trigger.value)
  if (index < 0) return trigger.value
  return focusable[index + (reverse ? -1 : 1)] || trigger.value
}

function setOptionRef(element, index) {
  if (element) optionRefs.value[index] = element
}

function onDocumentPointerDown(event) {
  if (trigger.value?.contains(event.target) || menu.value?.contains(event.target)) return
  close()
}

function optionId(option) {
  return `${listboxId}-${String(option).replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`
}

onUnmounted(close)
</script>

<script>
let trackerCategorySelectId = 0

function nextSelectId() {
  trackerCategorySelectId += 1
  return trackerCategorySelectId
}
</script>
