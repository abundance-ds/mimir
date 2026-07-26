<template>
  <div class="about-page">
    <div class="about-hero">
      <span class="about-title">Mim</span>
      <span class="about-version">v0.1.0</span>
    </div>

    <div class="about-links">
      <a href="https://shoulde.rs" target="_blank" rel="noopener">shoulde.rs</a>
    </div>

    <section class="agent-instructions" aria-labelledby="agent-instructions-title">
      <div>
        <h2 id="agent-instructions-title">Agent instructions</h2>
        <p>Optional starter text. Mim never writes project instruction files.</p>
      </div>
      <div class="instruction-actions">
        <button type="button" data-copy-agents @click="copy('agents')">
          <IconCopy :size="12" />
          {{ copied === 'agents' ? 'Copied AGENTS.md' : 'Copy AGENTS.md' }}
        </button>
        <button type="button" data-copy-claude @click="copy('claude')">
          <IconCopy :size="12" />
          {{ copied === 'claude' ? 'Copied CLAUDE.md' : 'Copy CLAUDE.md' }}
        </button>
      </div>
      <p v-if="error" role="alert" class="copy-error">{{ error }}</p>
    </section>

    <span class="about-copy">&copy; 2026</span>
  </div>
</template>

<script setup>
import { onUnmounted, ref } from 'vue'
import { IconCopy } from '@tabler/icons-vue'
import { AGENTS_STARTER, CLAUDE_ALIAS } from '../../agentInstructions.js'

const copied = ref('')
const error = ref('')
let resetTimer = null

async function copy(kind) {
  error.value = ''
  const content = kind === 'claude' ? CLAUDE_ALIAS : AGENTS_STARTER
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.')
    await navigator.clipboard.writeText(content)
    copied.value = kind
    clearTimeout(resetTimer)
    resetTimer = setTimeout(() => { copied.value = '' }, 1800)
  } catch (cause) {
    error.value = cause?.message || String(cause)
  }
}

onUnmounted(() => clearTimeout(resetTimer))
</script>

<style scoped>
.about-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding-top: 40px;
}

.about-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 16px;
}

.about-title {
  font-family: var(--font-brand);
  font-size: 24px;
  font-weight: 400;
  color: var(--color-ink);
}

.about-version {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-ink-3);
  margin-top: 4px;
}

.about-links {
  font-family: var(--font-sans);
  font-size: 11px;
  margin-bottom: 20px;
}
.about-links a {
  color: var(--color-accent);
  text-decoration: none;
}
.about-links a:hover {
  text-decoration: underline;
}

.agent-instructions {
  width: min(100%, 360px);
  margin: 4px 0 22px;
  padding: 14px 0;
  border-block: 1px solid var(--color-rule-light);
  text-align: left;
}

.agent-instructions h2 {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 600;
  color: var(--color-ink-2);
}

.agent-instructions p {
  margin: 3px 0 0;
  font-family: var(--font-sans);
  font-size: 9px;
  line-height: 1.45;
  color: var(--color-ink-3);
}

.instruction-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 10px;
}

.instruction-actions button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 27px;
  padding: 0 9px;
  border: 1px solid var(--color-rule);
  border-radius: 4px;
  background: var(--color-chrome-mid);
  color: var(--color-ink-2);
  font-family: var(--font-sans);
  font-size: 9px;
}

.instruction-actions button:hover {
  border-color: var(--color-accent);
  color: var(--color-ink);
}

.instruction-actions button:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.agent-instructions .copy-error {
  color: var(--color-rem);
}

.about-copy {
  font-family: var(--font-sans);
  font-size: 10px;
  color: var(--color-ink-3);
}
</style>
