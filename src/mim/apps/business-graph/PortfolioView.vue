<template>
  <div data-project-portfolio class="min-h-0 flex-1 overflow-y-auto bg-chrome-high p-2">
    <div class="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
      <button
        v-for="project in projects"
        :key="project.id"
        type="button"
        :data-project-card="project.id"
        class="min-h-36 border border-rule bg-surface p-3 text-left hover:border-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        @click="$emit('open', project.id)"
      >
        <div class="flex items-start gap-2">
          <span class="grid size-7 shrink-0 place-items-center border border-add/30 bg-add/5 text-add">
            <IconBriefcase2 :size="13" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block line-clamp-2 text-[11px] font-semibold leading-tight text-ink-2">
              {{ project.title || project.id }}
            </span>
            <span class="mt-0.5 block truncate font-mono text-[7px] text-ink-4">{{ project.id }}</span>
          </span>
          <span class="size-2 rounded-full" :class="health(project).dot" :title="health(project).label" />
        </div>
        <p v-if="project.summary" class="mt-2 line-clamp-2 text-[8.5px] leading-relaxed text-ink-3">
          {{ project.summary }}
        </p>
        <dl class="mt-3 grid grid-cols-3 gap-1 border-y border-rule-light py-2 text-center">
          <div>
            <dt class="font-mono text-[6px] uppercase text-ink-4">Open</dt>
            <dd class="mt-0.5 text-[11px] font-semibold text-ink-2">{{ metrics(project).open }}</dd>
          </div>
          <div>
            <dt class="font-mono text-[6px] uppercase text-ink-4">Waiting</dt>
            <dd class="mt-0.5 text-[11px] font-semibold" :class="metrics(project).waiting ? 'text-rem' : 'text-ink-2'">
              {{ metrics(project).waiting }}
            </dd>
          </div>
          <div>
            <dt class="font-mono text-[6px] uppercase text-ink-4">Done</dt>
            <dd class="mt-0.5 text-[11px] font-semibold text-add">{{ metrics(project).done }}</dd>
          </div>
        </dl>
        <div class="mt-2 flex items-center gap-1.5 font-mono text-[7px] text-ink-4">
          <IconBuilding :size="9" />
          <span class="min-w-0 flex-1 truncate">{{ company(project) }}</span>
          <span>{{ scope(project.scopeId) }}</span>
        </div>
      </button>
    </div>
    <div v-if="!projects.length" class="grid min-h-56 place-items-center text-center">
      <div>
        <IconBriefcaseOff :size="22" class="mx-auto text-ink-4" />
        <p class="mt-2 text-[9px] text-ink-3">No projects in these scopes.</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import {
  IconBriefcase2,
  IconBriefcaseOff,
  IconBuilding,
} from '@tabler/icons-vue'

const props = defineProps({
  projects: { type: Array, default: () => [] },
  issues: { type: Array, default: () => [] },
  nodes: { type: Array, default: () => [] },
  scopes: { type: Array, default: () => [] },
})

defineEmits(['open'])
const byId = computed(() => new Map(props.nodes.map(node => [node.id, node])))

function projectIssues(project) {
  return props.issues.filter(issue => (
    issue.projectId === project.id
    || issue.relations?.some(edge => edge.relation === 'part_of' && edge.target === project.id)
  ))
}

function metrics(project) {
  const issues = projectIssues(project)
  return {
    open: issues.filter(issue => !['done', 'cancelled'].includes(issue.status)).length,
    waiting: issues.filter(issue => issue.status === 'waiting' || issue.waitingFor).length,
    done: issues.filter(issue => issue.status === 'done').length,
  }
}

function health(project) {
  const values = metrics(project)
  const overdue = projectIssues(project).some(issue => (
    issue.dueDate
    && issue.dueDate < new Date().toISOString().slice(0, 10)
    && !['done', 'cancelled'].includes(issue.status)
  ))
  if (overdue || values.waiting > 1) return { label: 'Needs attention', dot: 'bg-rem' }
  if (values.open) return { label: 'Active', dot: 'bg-accent' }
  return { label: 'Clear', dot: 'bg-add' }
}

function company(project) {
  const target = project.relations?.find(edge => edge.relation === 'for_company')?.target
  return target ? byId.value.get(target)?.title || target : 'No company linked'
}

function scope(id) {
  return props.scopes.find(item => item.id === id)?.kind || 'source'
}
</script>
