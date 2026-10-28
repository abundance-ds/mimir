<template>
  <section class="pipeline-people" aria-label="Connections">
    <h3>Connections</h3>
    <p v-if="state === 'missing'" class="pipeline-note">No connections file. Add {{ path }} to the Team repository to show connections.</p>
    <p v-else-if="state === 'error'" class="pipeline-note" role="alert">The connections file could not be read.</p>
    <p v-else-if="state === 'loading'" class="pipeline-note" role="status">Loading connections</p>
    <p v-else-if="!people.length" class="pipeline-note">No connections match this company. Add another name in connectionAliases to match more.</p>
    <template v-else>
      <p class="pipeline-note">Roles are a guess from the job title.</p>
      <div v-for="group in groups" :key="group.role" class="pipeline-role-group">
        <h4>{{ group.role }} <span>{{ group.people.length }}</span></h4>
        <ul>
          <li v-for="(person, index) in group.people" :key="`${person.name}-${index}`">
            <div class="pipeline-person-line">
              <button v-if="person.url" type="button" class="pipeline-person-link"
                :data-graph-control="`pipeline-person-${group.role.replaceAll(' ', '-').toLowerCase()}-${index}`"
                :title="`Open the profile of ${person.name}`" @click="open(person.url)">
                {{ person.name }}<IconExternalLink :size="11" aria-hidden="true" />
              </button>
              <span v-else class="pipeline-person-name">{{ person.name }}</span>
              <span class="pipeline-person-meta">{{ person.position || 'No job title' }}</span>
            </div>
            <div class="pipeline-person-facts">
              <span v-if="person.connectedOn">Connected {{ person.connectedOn }}</span>
              <span>Messaged: {{ person.messaged ? 'Yes' : 'No' }}</span>
              <span v-if="showCompany && person.company">{{ person.company }}</span>
            </div>
            <p v-if="person.previous" class="pipeline-person-previous">{{ person.previous }}</p>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { IconExternalLink } from '@tabler/icons-vue'
import { openExternalUrl } from '../../../services/externalLinks.js'
import { groupByRole } from './pipelineModel.js'
import { CONNECTIONS_PATH } from '../../../stores/businessGraphPipeline.js'

const props = defineProps({
  people: { type: Array, default: () => [] },
  state: { type: String, default: 'ready' },
  showCompany: { type: Boolean, default: false },
})
const emit = defineEmits(['notice'])
const path = CONNECTIONS_PATH
const groups = computed(() => groupByRole(props.people))
async function open(url) {
  try { await openExternalUrl(url) } catch (cause) { emit('notice', cause instanceof Error ? cause.message : String(cause)) }
}
</script>

<style scoped>
.pipeline-people h3 { margin-bottom: 4px; color: var(--color-ink-2); font-size: 11px; font-weight: 650; }
.pipeline-note { color: var(--color-ink-3); font-size: 11px; line-height: 1.45; }
.pipeline-role-group { margin-top: 8px; }
.pipeline-role-group h4 { color: var(--color-ink-2); font-size: 10.5px; font-weight: 650; }
.pipeline-role-group h4 span { color: var(--color-ink-3); font-weight: 400; }
.pipeline-role-group ul { display: grid; gap: 6px; margin-top: 4px; }
.pipeline-role-group li { display: grid; gap: 2px; padding-bottom: 6px; border-bottom: 1px solid var(--color-rule-light); font-size: 11px; }
.pipeline-person-line { display: flex; min-width: 0; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.pipeline-person-link { display: inline-flex; align-items: center; gap: 3px; color: var(--color-accent); font-size: 11px; font-weight: 600; }
.pipeline-person-link:hover { text-decoration: underline; }
.pipeline-person-link:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 1px; }
.pipeline-person-name { color: var(--color-ink); font-weight: 600; }
.pipeline-person-meta, .pipeline-person-facts { color: var(--color-ink-3); }
.pipeline-person-facts { display: flex; flex-wrap: wrap; gap: 10px; font-size: 10px; }
.pipeline-person-previous { color: var(--color-ink-2); font-size: 10.5px; line-height: 1.45; user-select: text; }
</style>
