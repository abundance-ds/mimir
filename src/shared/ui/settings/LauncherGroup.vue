<template>
  <section :aria-label="title">
    <div class="mb-1.5 flex items-center justify-between">
      <h3 class="m-0 text-[9px] font-semibold uppercase tracking-[1.8px] text-ink-3">{{ title }}</h3>
      <span class="font-mono text-[9px] tabular-nums text-ink-4">{{ rows.length }}</span>
    </div>
    <div class="overflow-hidden border border-rule-light bg-surface">
      <article
        v-for="row in rows"
        :key="row.key"
        data-launcher-preset
        class="border-b border-rule-light last:border-b-0"
      >
        <div class="flex min-h-[48px] items-center gap-2.5 px-3 py-2">
          <span class="grid size-7 shrink-0 place-items-center bg-chrome-mid text-ink-2">
            <component
              :is="iconFor(row)"
              :size="15"
              :stroke-width="1.8"
              :monochrome="true"
            />
          </span>

          <button
            type="button"
            class="min-w-0 flex-1 text-left focus-visible:outline-none"
            :aria-expanded="openId === row.key"
            :aria-controls="`launcher-details-${row.key}`"
            @click="$emit('toggleOpen', row.key)"
          >
            <span class="flex min-w-0 items-center gap-1.5">
              <strong class="truncate text-[11.5px] font-medium text-ink">{{ row.title || 'Untitled preset' }}</strong>
              <span
                v-if="agentFor(row)?.version"
                class="shrink-0 bg-chrome-mid px-1 font-mono text-[8.5px] text-ink-3"
              >
                {{ agentFor(row).version }}
              </span>
            </span>
            <span class="mt-0.5 flex min-w-0 items-center gap-1.5">
              <span class="truncate font-mono text-[9px]" :class="available(row) ? 'text-ink-3' : 'text-rem'">
                {{ commandLabel(row) }}
              </span>
              <span v-if="row.flagsText" class="truncate bg-chrome-mid px-1 font-mono text-[8.5px] text-ink-3">
                {{ row.flagsText }}
              </span>
            </span>
          </button>

          <span
            class="hidden shrink-0 items-center gap-1 text-[9px] sm:flex"
            :class="available(row) ? 'text-ink-4' : 'text-rem'"
          >
            <span class="size-1.5 rounded-full" :class="available(row) ? 'bg-add' : 'bg-rem'" />
            {{ available(row) ? 'Ready' : 'Not found' }}
          </span>

          <button
            type="button"
            :data-launcher-customize="row.id"
            class="shrink-0 px-1.5 py-1 text-[9.5px] font-medium text-accent hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click="$emit('toggleOpen', row.key)"
          >
            {{ openId === row.key ? 'Close' : 'Customise' }}
          </button>

          <button
            type="button"
            role="switch"
            :data-launcher-enabled="row.id"
            class="launcher-switch"
            :class="{ 'launcher-switch-on': row.enabled && available(row) }"
            :aria-checked="row.enabled && available(row)"
            :aria-label="`${row.title || 'Preset'} launcher ${row.enabled && available(row) ? 'shown' : 'hidden'}`"
            :title="switchTitle(row)"
            :disabled="!available(row)"
            @click="$emit('toggleEnabled', row.key, !row.enabled)"
          >
            <span />
          </button>
        </div>

        <div
          v-if="openId === row.key"
          :id="`launcher-details-${row.key}`"
          class="border-t border-rule-light bg-chrome-low px-3 pb-3 pt-2.5"
        >
          <label class="launcher-field">
            <span>CLI flags</span>
            <input
              v-model="row.flagsText"
              data-launcher-args
              type="text"
              autocomplete="off"
              spellcheck="false"
              :placeholder="flagsPlaceholder(row)"
              class="font-mono"
            />
            <small>Write flags exactly as you would in a terminal. Quotes preserve spaces.</small>
          </label>

          <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span>
              <span class="block text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-3">Start in</span>
              <span class="mt-0.5 block text-[9px] text-ink-4">The folder this CLI session opens in</span>
            </span>
            <div class="launcher-segments" aria-label="Working directory">
              <button
                v-for="option in cwdOptions"
                :key="option.id"
                type="button"
                :class="{ active: row.cwdMode === option.id }"
                :aria-pressed="row.cwdMode === option.id"
                @click="row.cwdMode = option.id"
              >
                {{ option.label }}
              </button>
            </div>
          </div>
          <label v-if="row.cwdMode === 'custom'" class="launcher-field mt-2">
            <span>Custom folder</span>
            <input
              v-model="row.cwdPath"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="/absolute/path"
              class="font-mono"
            />
          </label>

          <button
            type="button"
            :data-launcher-advanced="row.id"
            class="mt-3 flex items-center gap-1 text-[9.5px] font-medium text-ink-3 hover:text-ink"
            :aria-expanded="advancedId === row.key"
            @click="$emit('toggleAdvanced', row.key)"
          >
            <IconChevronRight
              :size="12"
              :stroke-width="2"
              class="transition-transform"
              :class="{ 'rotate-90': advancedId === row.key }"
            />
            Advanced details
          </button>

          <div v-if="advancedId === row.key" class="mt-2 grid gap-2.5 border-t border-rule-light pt-3 sm:grid-cols-2">
            <label class="launcher-field">
              <span>Name</span>
              <input v-model="row.title" type="text" autocomplete="off" />
            </label>
            <label class="launcher-field">
              <span>Preset id</span>
              <input v-model="row.id" data-launcher-id type="text" autocomplete="off" spellcheck="false" class="font-mono" />
              <small>Routines can refer to this stable id.</small>
            </label>
            <label class="launcher-field sm:col-span-2">
              <span>Command override</span>
              <input
                v-model="row.binary"
                data-launcher-binary
                type="text"
                autocomplete="off"
                spellcheck="false"
                :placeholder="row.kind === 'agent' ? 'Use the detected command' : 'Use the default login shell'"
                class="font-mono"
              />
            </label>
            <label class="launcher-field sm:col-span-2">
              <span>Environment</span>
              <textarea
                v-model="row.envText"
                data-launcher-env
                rows="2"
                spellcheck="false"
                placeholder="KEY=value"
                class="font-mono"
              />
              <small>One KEY=value entry per line.</small>
            </label>
            <div class="flex items-center justify-end sm:col-span-2">
              <button
                type="button"
                class="px-2 py-1 text-[9.5px] font-medium text-rem hover:bg-rem/10"
                @click="$emit('remove', row.key)"
              >
                Remove preset
              </button>
            </div>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup>
import { IconChevronRight, IconMathPi, IconRobot, IconTerminal2 } from '@tabler/icons-vue'
import IconProviderAnthropic from '../../../shared/icons/IconProviderAnthropic.vue'
import IconProviderGoogle from '../../../shared/icons/IconProviderGoogle.vue'
import IconProviderOpenAI from '../../../shared/icons/IconProviderOpenAI.vue'

const props = defineProps({
  title: { type: String, required: true },
  rows: { type: Array, default: () => [] },
  agents: { type: Array, default: () => [] },
  openId: { type: String, default: '' },
  advancedId: { type: String, default: '' },
})

defineEmits(['toggleOpen', 'toggleAdvanced', 'toggleEnabled', 'remove'])

const cwdOptions = [
  { id: 'workspace', label: 'Project' },
  { id: 'home', label: 'Home' },
  { id: 'custom', label: 'Custom' },
]

function agentFor(row) {
  return props.agents.find(agent => agent.id === row.agentId) || null
}

function available(row) {
  return row.kind === 'terminal' || Boolean(row.binary.trim()) || Boolean(agentFor(row)?.installed)
}

function commandLabel(row) {
  if (row.binary.trim()) return row.binary.trim()
  if (row.kind === 'terminal') return 'Default login shell'
  const agent = agentFor(row)
  return agent?.installed ? (agent.binaryPath || agent.binary || row.agentId) : 'Not installed'
}

function iconFor(row) {
  if (row.kind === 'terminal') return IconTerminal2
  if (row.agentId === 'codex') return IconProviderOpenAI
  if (row.agentId === 'claude') return IconProviderAnthropic
  if (row.agentId === 'pi') return IconMathPi
  if (row.agentId === 'gemini') return IconProviderGoogle
  return IconRobot
}

function flagsPlaceholder(row) {
  return {
    codex: '--model gpt-5 --full-auto',
    claude: '--dangerously-skip-permissions --verbose',
    pi: '--model openai/gpt-5',
    gemini: '--model gemini-2.5-pro',
  }[row.agentId] || '--flag value'
}

function switchTitle(row) {
  if (!available(row)) return 'Install the CLI or set a command override first'
  return row.enabled ? 'Hide launcher from the sidebar' : 'Show launcher in the sidebar'
}
</script>

<style scoped>
.launcher-switch {
  position: relative;
  width: 32px;
  height: 18px;
  flex-shrink: 0;
  border: 1px solid var(--color-rule);
  border-radius: 999px;
  background: var(--color-chrome);
  padding: 0;
}
.launcher-switch span {
  position: absolute;
  left: 2px;
  top: 2px;
  width: 12px;
  height: 12px;
  border-radius: 999px;
  background: white;
  transition: transform 120ms ease;
}
.launcher-switch-on {
  border-color: var(--color-accent);
  background: var(--color-accent);
}
.launcher-switch-on span {
  transform: translateX(14px);
}
.launcher-switch:disabled {
  opacity: 0.35;
}
.launcher-field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-ink-3);
}
.launcher-field small {
  font-size: 9px;
  font-weight: 400;
  line-height: 1.35;
  text-transform: none;
  letter-spacing: 0;
  color: var(--color-ink-4);
}
.launcher-field input,
.launcher-field textarea {
  width: 100%;
  border: 1px solid var(--color-rule-light);
  border-radius: 4px;
  background: var(--color-surface);
  padding: 5px 7px;
  font-size: 10px;
  font-weight: 400;
  line-height: 1.45;
  text-transform: none;
  letter-spacing: 0;
  color: var(--color-ink);
  outline: none;
}
.launcher-field input {
  height: 28px;
}
.launcher-field textarea {
  resize: vertical;
}
.launcher-field input:focus,
.launcher-field textarea:focus {
  border-color: var(--color-accent);
  box-shadow: inset 0 0 0 1px var(--color-accent-soft);
}
.launcher-segments {
  display: flex;
  height: 25px;
  align-items: center;
  overflow: hidden;
  border: 1px solid var(--color-rule-light);
  border-radius: 5px;
  background: var(--color-surface);
  padding: 1px;
}
.launcher-segments button {
  height: 21px;
  padding: 0 8px;
  border-radius: 3px;
  font-size: 9px;
  color: var(--color-ink-3);
}
.launcher-segments button:hover:not(.active) {
  color: var(--color-ink);
}
.launcher-segments button.active {
  background: var(--color-chrome-high);
  font-weight: 600;
  color: var(--color-ink);
}
@media (prefers-reduced-motion: reduce) {
  .launcher-switch span,
  .transition-transform {
    transition: none;
  }
}
</style>
