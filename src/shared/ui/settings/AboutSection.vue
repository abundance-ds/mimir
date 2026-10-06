<template>
  <div class="about-page">
    <div class="about-hero">
      <span class="about-title">Mimir</span>
      <span class="about-version">{{ versionLabel }}</span>
    </div>

    <div class="about-links">
      <a href="https://abundanceds.com" target="_blank" rel="noopener">abundanceds.com</a>
    </div>

    <span class="about-copy">&copy; 2026</span>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { useAppUpdateStore } from '../../../stores/appUpdate.js'

const updates = useAppUpdateStore()
const versionLabel = computed(() => (
  updates.currentVersion ? `v${updates.currentVersion.replace(/^v/, '')}` : 'v—'
))

onMounted(() => { void updates.loadVersion() })
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

.about-copy {
  font-family: var(--font-sans);
  font-size: 10px;
  color: var(--color-ink-3);
}
</style>
