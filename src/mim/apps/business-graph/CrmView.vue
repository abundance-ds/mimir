<template>
  <div data-graph-crm class="crm">
    <section v-if="companies.length" class="crm-summary" aria-label="CRM overview">
      <div>
        <strong>{{ companies.length }}</strong>
        <span>{{ companies.length === 1 ? 'company' : 'companies' }}</span>
      </div>
      <div>
        <strong>{{ linkedPeople }}</strong>
        <span>linked people</span>
      </div>
      <div>
        <strong>{{ activeProjects }}</strong>
        <span>active projects</span>
      </div>
      <div>
        <strong :class="{ attention: totalOpenWork }">{{ totalOpenWork }}</strong>
        <span>open work</span>
      </div>
    </section>

    <div v-if="companies.length" class="crm-list">
      <article
        v-for="company in companies"
        :key="company.id"
        :data-company-card="company.id"
        class="company-row"
      >
        <button
          type="button"
          :data-graph-control="`crm-open-${company.id}`"
          class="company-identity"
          @click="$emit('open', company.id)"
        >
          <span class="company-monogram">{{ initials(company.title) }}</span>
          <span>
            <strong>{{ company.title || company.id }}</strong>
            <small>{{ company.summary || company.id }}</small>
          </span>
        </button>

        <dl class="company-metrics">
          <div>
            <dd>{{ contacts(company).length }}</dd>
            <dt>people</dt>
          </div>
          <div>
            <dd>{{ projects(company).length }}</dd>
            <dt>projects</dt>
          </div>
          <div>
            <dd :class="{ attention: openWork(company) }">{{ openWork(company) }}</dd>
            <dt>open</dt>
          </div>
        </dl>

        <div class="company-projects">
          <span>Current work</span>
          <p v-if="projects(company).length">
            {{ projects(company).slice(0, 2).map(project => project.title || project.id).join(' · ') }}
          </p>
          <p v-else class="muted">No project linked</p>
        </div>

        <div class="company-contact">
          <span>Next contact</span>
          <button
            v-if="contacts(company)[0]"
            type="button"
            :data-graph-control="`crm-contact-${contacts(company)[0].id}`"
            @click="$emit('open', contacts(company)[0].id)"
          >
            <i>{{ initials(contacts(company)[0].title) }}</i>
            <span>{{ contacts(company)[0].title }}</span>
          </button>
          <p v-else>No contact linked</p>
        </div>
      </article>
    </div>

    <div v-else class="crm-empty">
      <h2>No companies in these scopes</h2>
      <p>Add a company to connect contacts, projects, requests, and delivery work.</p>
      <button
        type="button"
        data-graph-control="crm-empty-create"
        @click="$emit('create')"
      >
        Add company
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  companies: { type: Array, default: () => [] },
  people: { type: Array, default: () => [] },
  projects: { type: Array, default: () => [] },
  issues: { type: Array, default: () => [] },
})

defineEmits(['open', 'create'])

const linkedPeople = computed(() => new Set(
  props.companies.flatMap(company => contacts(company).map(person => person.id)),
).size)
const activeProjects = computed(() => new Set(
  props.companies.flatMap(company => projects(company).map(project => project.id)),
).size)
const totalOpenWork = computed(() => props.companies.reduce(
  (total, company) => total + openWork(company),
  0,
))

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

function initials(value) {
  return String(value || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0])
    .join('')
    .toUpperCase()
}
</script>

<style scoped>
.crm {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 15px;
}

.crm-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(100px, 1fr));
  overflow: hidden;
  border: 1px solid var(--color-rule-light);
  border-radius: 2px;
  background: var(--color-surface);
}

.crm-summary > div {
  min-height: 74px;
  border-right: 1px solid var(--color-rule-light);
  padding: 14px 16px;
}

.crm-summary > div:last-child {
  border-right: 0;
}

.crm-summary strong,
.crm-summary span {
  display: block;
}

.crm-summary strong {
  color: var(--color-ink);
  font-size: 18px;
  font-weight: 660;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.03em;
}

.crm-summary strong.attention {
  color: var(--color-accent);
}

.crm-summary span {
  margin-top: 3px;
  color: var(--color-ink-4);
  font-size: 9px;
}

.crm-list {
  margin-top: 12px;
  overflow: hidden;
  border: 1px solid var(--color-rule-light);
  border-radius: 2px;
  background: var(--color-surface);
}

.company-row {
  display: grid;
  min-height: 104px;
  grid-template-columns: minmax(200px, 1.15fr) 170px minmax(160px, 0.9fr) minmax(150px, 0.8fr);
  align-items: center;
  gap: 16px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 13px 16px;
}

.company-row:last-child {
  border-bottom: 0;
}

.company-row:hover {
  background: color-mix(in srgb, var(--color-chrome-mid) 48%, transparent);
}

.company-identity {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 12px;
  border-radius: 6px;
  text-align: left;
}

.company-identity:focus-visible,
.company-contact button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-accent) 26%, transparent);
  outline-offset: 3px;
}

.company-monogram {
  display: grid;
  width: 37px;
  height: 37px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 2px;
  border: 1px solid var(--color-rule);
  background: var(--color-chrome-high);
  color: var(--color-accent);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 730;
}

.company-identity > span:last-child {
  min-width: 0;
}

.company-identity strong,
.company-identity small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.company-identity strong {
  color: var(--color-ink);
  font-size: 13px;
  font-weight: 640;
}

.company-identity small {
  margin-top: 4px;
  color: var(--color-ink-4);
  font-size: 9px;
}

.company-metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.company-metrics dd {
  color: var(--color-ink);
  font-size: 13px;
  font-weight: 650;
}

.company-metrics dd.attention {
  color: var(--color-accent);
}

.company-metrics dt,
.company-projects > span,
.company-contact > span {
  margin-top: 2px;
  color: var(--color-ink-4);
  font-size: 9px;
}

.company-projects,
.company-contact {
  min-width: 0;
}

.company-projects > span,
.company-contact > span {
  display: block;
  margin: 0 0 6px;
  font-weight: 620;
  letter-spacing: 0.045em;
  text-transform: uppercase;
}

.company-projects p {
  overflow: hidden;
  color: var(--color-ink-2);
  font-size: 10px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.company-projects p.muted,
.company-contact p {
  color: var(--color-ink-4);
}

.company-contact button {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
  border-radius: 4px;
  color: var(--color-ink-2);
  font-size: 10px;
}

.company-contact button:hover {
  color: var(--color-accent);
}

.company-contact button i {
  display: grid;
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 50%;
  background: var(--color-chrome-mid);
  color: var(--color-ink-3);
  font-size: 9px;
  font-style: normal;
  font-weight: 700;
}

.company-contact button span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.crm-empty {
  display: grid;
  min-height: 330px;
  place-content: center;
  justify-items: center;
  text-align: center;
}

.crm-empty h2 {
  margin-top: 14px;
  color: var(--color-ink);
  font-size: 14px;
  font-weight: 650;
}

.crm-empty p {
  max-width: 400px;
  margin-top: 6px;
  color: var(--color-ink-3);
  font-size: 11px;
  line-height: 1.5;
}

.crm-empty > button {
  min-height: 34px;
  margin-top: 16px;
  border: 1px solid var(--color-rule);
  border-radius: 5px;
  background: var(--color-surface);
  padding: 0 11px;
  color: var(--color-ink-2);
  font-size: 11px;
  font-weight: 650;
}

.crm-empty > button:hover {
  background: var(--color-chrome-mid);
}

@container business-graph (max-width: 820px) {
  .company-row {
    grid-template-columns: minmax(180px, 1fr) 150px minmax(130px, 0.8fr);
  }

  .company-projects {
    display: none;
  }
}

@container business-graph (max-width: 560px) {
  .crm-summary {
    grid-template-columns: repeat(2, 1fr);
  }

  .crm-summary > div:nth-child(3) {
    border-right: 1px solid var(--color-rule-light);
    border-top: 1px solid var(--color-rule-light);
  }

  .crm-summary > div:nth-child(4) {
    border-right: 0;
    border-top: 1px solid var(--color-rule-light);
  }

  .crm-summary > div:nth-child(2) {
    border-right: 0;
  }

  .company-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .company-metrics {
    display: none;
  }
}
</style>
