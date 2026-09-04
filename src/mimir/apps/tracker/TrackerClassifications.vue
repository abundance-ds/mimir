<template>
  <section data-tracker-classifications class="flex min-h-0 flex-1 flex-col bg-surface">
    <header class="flex h-7 items-center gap-2 border-b border-rule-light px-3">
      <h2 class="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-ink-2">Classification rules</h2>
      <label class="ml-auto flex h-6 min-w-[160px] max-w-[280px] flex-1 items-center border border-rule bg-surface px-2 focus-within:border-accent">
        <IconSearch :size="11" class="text-ink-4" />
        <input
          v-model="query"
          data-tracker-classification-search
          type="search"
          placeholder="Find app or domain"
          class="min-w-0 flex-1 border-0 bg-transparent px-1.5 text-[9px] outline-none placeholder:text-ink-4"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
        >
      </label>
    </header>

    <div v-if="error" class="border-b border-rem/25 bg-rem/5 px-3 py-2 text-[9px] text-rem" role="alert">{{ error }}</div>
    <div class="min-h-0 flex-1 overflow-auto">
      <table class="w-full min-w-[650px] table-fixed text-left">
        <thead class="sticky top-0 z-10 bg-chrome-high">
          <tr class="border-b border-rule-light font-mono text-[9px] uppercase tracking-[0.1em] text-ink-4">
            <th class="w-[240px] px-3 py-2 font-medium">Application key</th>
            <th class="w-[116px] px-2 py-2 font-medium">Category</th>
            <th class="px-2 py-2 font-medium">Subcategory</th>
            <th class="w-[86px] px-2 py-2 font-medium">Source</th>
            <th class="w-[62px] px-2 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="rule in filtered"
            :key="rule.key"
            class="border-b border-rule-light text-[10px]"
            :data-tracker-classification="rule.key"
          >
            <td class="truncate px-3 py-2 font-mono text-ink-2" :title="rule.key">{{ rule.key }}</td>
            <td class="px-2 py-1.5">
              <TrackerCategorySelect
                :model-value="draft(rule).activity"
                :options="categories"
                :aria-label="`Category for ${rule.key}`"
                @update:model-value="patch(rule, { activity: $event })"
              />
            </td>
            <td class="px-2 py-1.5">
              <input
                :value="draft(rule).subcategory"
                class="h-7 w-full border border-rule bg-surface px-1.5 text-[10px] text-ink outline-none focus:border-accent"
                placeholder="Uncategorized"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
                @input="patch(rule, { subcategory: $event.target.value })"
                @keydown.enter.prevent="save(rule)"
              >
            </td>
            <td class="px-2 py-2 font-mono text-[9px] text-ink-4">
              {{ rule.manual ? 'manual' : rule.classifiedBy }}
            </td>
            <td class="px-2 py-1.5">
              <button
                type="button"
                data-tracker-classification-save
                :disabled="saving.has(rule.key) || !changed(rule)"
                class="h-7 w-full border border-accent/40 px-1.5 text-[9px] font-semibold text-accent hover:bg-accent-soft disabled:border-rule disabled:text-ink-4 disabled:opacity-50"
                @click="save(rule)"
              >
                {{ saving.has(rule.key) ? '…' : 'Save' }}
              </button>
            </td>
          </tr>
          <tr v-if="!filtered.length">
            <td colspan="5" class="px-3 py-12 text-center text-[9px] text-ink-4">
              {{ query ? 'No rule matches this search.' : 'New applications will appear here for classification.' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <footer class="flex min-h-9 items-center border-t border-rule-light px-3 text-[9px] text-ink-4">
      Saving updates matching history. System intervals (AFK, OFF, Break) are never reclassified.
      <span class="ml-auto font-mono">{{ filtered.length }}/{{ rules.length }}</span>
    </footer>
  </section>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { IconSearch } from '@tabler/icons-vue'
import TrackerCategorySelect from './TrackerCategorySelect.vue'

const props = defineProps({
  rules: { type: Array, default: () => [] },
  saveRule: { type: Function, required: true },
})

const emit = defineEmits(['saved'])
const categories = ['Work', 'Leisure', 'Other', 'UNKNOWN']
const query = ref('')
const drafts = reactive({})
const saving = reactive(new Set())
const error = ref('')
const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return needle
    ? props.rules.filter(rule => [
        rule.key,
        rule.activity,
        rule.subcategory,
        rule.classifiedBy,
      ].some(value => String(value || '').toLowerCase().includes(needle)))
    : props.rules
})

watch(() => props.rules, (rules) => {
  const keys = new Set(rules.map(rule => rule.key))
  for (const key of Object.keys(drafts)) {
    if (!keys.has(key)) delete drafts[key]
  }
}, { deep: false })

function draft(rule) {
  return drafts[rule.key] || {
    activity: rule.activity,
    subcategory: rule.subcategory || '',
  }
}

function patch(rule, value) {
  drafts[rule.key] = { ...draft(rule), ...value }
}

function changed(rule) {
  const value = draft(rule)
  return value.activity !== rule.activity
    || value.subcategory.trim() !== String(rule.subcategory || '').trim()
}

async function save(rule) {
  if (!changed(rule) || saving.has(rule.key)) return
  saving.add(rule.key)
  error.value = ''
  const value = draft(rule)
  try {
    await props.saveRule({
      key: rule.key,
      activity: value.activity,
      subcategory: value.subcategory.trim() || null,
      applyHistory: true,
    })
    delete drafts[rule.key]
    emit('saved')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.delete(rule.key)
  }
}
</script>

<style scoped>
button:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: -1px;
}
</style>
