<template>
  <div data-graph-crm class="min-h-0 flex-1 overflow-y-auto bg-chrome-high p-2">
    <div class="grid grid-cols-[repeat(auto-fill,minmax(235px,1fr))] gap-2">
      <article
        v-for="company in companies"
        :key="company.id"
        :data-company-card="company.id"
        class="border border-rule bg-surface"
      >
        <button
          type="button"
          class="flex min-h-14 w-full items-start gap-2 border-b border-rule-light p-3 text-left hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="$emit('open', company.id)"
        >
          <span class="grid size-7 shrink-0 place-items-center border border-rule-light bg-chrome-high text-ink-3">
            <IconBuilding :size="13" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[11px] font-semibold text-ink-2">{{ company.title }}</span>
            <span class="block truncate font-mono text-[7px] text-ink-4">{{ company.id }}</span>
          </span>
          <IconChevronRight :size="12" class="mt-2 text-ink-4" />
        </button>
        <div class="grid grid-cols-3 divide-x divide-rule-light border-b border-rule-light text-center">
          <div class="py-2">
            <div class="text-[11px] font-semibold text-ink-2">{{ contacts(company).length }}</div>
            <div class="font-mono text-[6px] uppercase text-ink-4">people</div>
          </div>
          <div class="py-2">
            <div class="text-[11px] font-semibold text-ink-2">{{ projects(company).length }}</div>
            <div class="font-mono text-[6px] uppercase text-ink-4">projects</div>
          </div>
          <div class="py-2">
            <div class="text-[11px] font-semibold" :class="openWork(company) ? 'text-accent' : 'text-ink-2'">
              {{ openWork(company) }}
            </div>
            <div class="font-mono text-[6px] uppercase text-ink-4">open</div>
          </div>
        </div>
        <div class="p-2">
          <div class="mb-1 font-mono text-[6px] uppercase tracking-[0.1em] text-ink-4">Next contact</div>
          <button
            v-if="contacts(company)[0]"
            type="button"
            class="flex h-8 w-full items-center gap-2 px-1 text-left hover:bg-chrome-mid"
            @click="$emit('open', contacts(company)[0].id)"
          >
            <IconUser :size="11" class="text-ink-4" />
            <span class="truncate text-[8.5px] text-ink-2">{{ contacts(company)[0].title }}</span>
          </button>
          <p v-else class="h-8 px-1 py-2 text-[8px] text-ink-4">No contact linked</p>
        </div>
      </article>
    </div>
    <div v-if="!companies.length" class="grid min-h-56 place-items-center text-[9px] text-ink-4">
      No companies in these scopes.
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import {
  IconBuilding,
  IconChevronRight,
  IconUser,
} from '@tabler/icons-vue'

const props = defineProps({
  companies: { type: Array, default: () => [] },
  people: { type: Array, default: () => [] },
  projects: { type: Array, default: () => [] },
  issues: { type: Array, default: () => [] },
})

defineEmits(['open'])
const projectById = computed(() => new Map(props.projects.map(project => [project.id, project])))

function contacts(company) {
  const projectContacts = new Set(
    projects(company).flatMap(project => (
      (project.relations || [])
        .filter(edge => edge.relation === 'has_contact')
        .map(edge => edge.target)
    )),
  )
  return props.people.filter(person => (
    projectContacts.has(person.id)
    || person.relations?.some(edge => (
      edge.target === company.id && ['works_at', 'contact_for'].includes(edge.relation)
    ))
  ))
}

function projects(company) {
  return props.projects.filter(project => project.relations?.some(edge => (
    edge.target === company.id && edge.relation === 'for_company'
  )))
}

function openWork(company) {
  const projectIds = new Set(projects(company).map(project => project.id))
  return props.issues.filter(issue => (
    projectIds.has(issue.projectId)
    && !['done', 'cancelled'].includes(issue.status)
  )).length
}
</script>
