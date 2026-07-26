<template>
  <div>
    <!-- ─── Theme ─── -->
    <div class="section-title">Theme</div>
    <div class="theme-grid">
      <button
        v-for="t in themes"
        :key="t.id"
        class="theme-swatch"
        :class="{ active: settings.editorTheme === t.id }"
        :style="settings.editorTheme === t.id ? { borderColor: t.accent } : {}"
        @click="settings.set('editorTheme', t.id)"
      >
        <div class="swatch-window" :style="{ background: t.surface }">
          <div class="swatch-titlebar" :style="{ background: t.chrome }"></div>
          <div class="swatch-body">
            <div class="swatch-sidebar" :style="{ background: t.chrome }"></div>
            <div class="swatch-content">
              <span class="swatch-line" :style="{ background: t.ink + '40', width: '60%' }"></span>
              <span class="swatch-line" :style="{ background: t.syntaxKeyword, width: '45%', opacity: 0.7 }"></span>
              <span class="swatch-line" :style="{ background: t.ink + '30', width: '70%' }"></span>
              <span class="swatch-line" :style="{ background: t.syntaxString, width: '35%', opacity: 0.7 }"></span>
              <span class="swatch-line" :style="{ background: t.ink + '28', width: '55%' }"></span>
            </div>
          </div>
        </div>
        <span class="swatch-label" :style="settings.editorTheme === t.id ? { color: t.accent } : {}">{{ t.label }}</span>
        <div class="swatch-dots">
          <span class="swatch-dot" :style="{ background: t.accent }"></span>
          <span class="swatch-dot" :style="{ background: t.add }"></span>
          <span class="swatch-dot" :style="{ background: t.rem }"></span>
          <span class="swatch-dot" :style="{ background: t.ink }"></span>
        </div>
      </button>
    </div>

    <!-- ─── Interface ─── -->
    <div class="section-title">Interface</div>
    <div class="setting-row">
      <div class="setting-label">
        Zoom
        <span class="setting-desc">Scales the whole window · ⌘+ / ⌘− · ⌘0 resets</span>
      </div>
      <div class="stepper">
        <button
          class="stepper-btn"
          aria-label="Zoom interface out"
          :disabled="settings.workbenchZoom <= WORKBENCH_ZOOM_LEVELS[0]"
          @click="settings.set('workbenchZoom', nextWorkbenchZoom(settings.workbenchZoom, 'out'))"
        >
          <IconMinus :size="10" />
        </button>
        <span class="stepper-value">{{ settings.workbenchZoom }}%</span>
        <button
          class="stepper-btn"
          aria-label="Zoom interface in"
          :disabled="settings.workbenchZoom >= WORKBENCH_ZOOM_LEVELS[WORKBENCH_ZOOM_LEVELS.length - 1]"
          @click="settings.set('workbenchZoom', nextWorkbenchZoom(settings.workbenchZoom, 'in'))"
        >
          <IconPlus :size="10" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { IconMinus, IconPlus } from '@tabler/icons-vue'
import { useSettingsStore } from '../../../stores/settings.js'
import { WORKBENCH_ZOOM_LEVELS, nextWorkbenchZoom } from '../../../shared/workbenchZoom.js'

const settings = useSettingsStore()

const themes = [
  { id: 'parchment', label: 'Light',   accent: '#c05d3c', chrome: '#ebe9e3', surface: '#ffffff', ink: '#1a1a18', syntaxKeyword: '#7c4dff', syntaxString: '#2e7d32', syntaxNumber: '#e65100', add: '#5e8b3e', rem: '#c05d3c' },
  { id: 'glacier',   label: 'North',   accent: '#4a7c9b', chrome: '#e4e8ec', surface: '#ffffff', ink: '#1a2a33', syntaxKeyword: '#6e56cf', syntaxString: '#297a3a', syntaxNumber: '#b35c00', add: '#3a8a4a', rem: '#c05050' },
  { id: 'studio',    label: 'Studio',  accent: '#E86420', chrome: '#D9D9D7', surface: '#F7F5F0', ink: '#1C1B1A', syntaxKeyword: '#7c4dff', syntaxString: '#2e7d32', syntaxNumber: '#b94d00', add: '#3A7D44', rem: '#C0392B' },
  { id: 'slate',     label: 'Dark',    accent: '#5a9e8f', chrome: '#1e2226', surface: '#2a2e33', ink: '#d8d8d4', syntaxKeyword: '#b39dff', syntaxString: '#7cc68a', syntaxNumber: '#e8a36d', add: '#7cc68a', rem: '#e07070' },
  { id: 'monokai',   label: 'Monokai',    accent: '#f97316', chrome: '#1a1a1a', surface: '#272822', ink: '#f8f8f2', syntaxKeyword: '#ae81ff', syntaxString: '#e6db74', syntaxNumber: '#fd971f', add: '#a6e22e', rem: '#f92672' },
  { id: 'dracula',   label: 'Dracula',    accent: '#bd93f9', chrome: '#151622', surface: '#1e1f2e', ink: '#f0eef8', syntaxKeyword: '#ff79c6', syntaxString: '#50fa7b', syntaxNumber: '#ffb86c', add: '#50fa7b', rem: '#ff5555' },
  { id: 'zenith',    label: 'Zenith',     accent: '#22d3ee', chrome: '#0a0e14', surface: '#0f1419', ink: '#f0f4f8', syntaxKeyword: '#f472b6', syntaxString: '#4ade80', syntaxNumber: '#fbbf24', add: '#4ade80', rem: '#f87171' },
  { id: 'synthwave', label: 'Synthwave',  accent: '#c678dd', chrome: '#141416', surface: '#1a1a1e', ink: '#e8e6f0', syntaxKeyword: '#36d7e0', syntaxString: '#ffd580', syntaxNumber: '#c792ea', add: '#72f1b8', rem: '#ff5572' },
]
</script>

<style scoped>
/* ── Theme swatches ── */

.theme-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  padding: 12px 0 20px;
}

.theme-swatch {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 0;
  border: 2px solid var(--color-rule-light);
  border-radius: 8px;
  background: transparent;
  min-width: 0;
}
.theme-swatch:hover:not(.active) {
  border-color: var(--color-rule);
}
.theme-swatch.active {
  box-shadow: 0 0 0 1px var(--color-surface);
}

.swatch-window {
  width: 100%;
  height: 62px;
  border-radius: 6px 6px 0 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.swatch-titlebar {
  height: 6px;
  flex-shrink: 0;
}

.swatch-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.swatch-sidebar {
  width: 14px;
  flex-shrink: 0;
}

.swatch-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 5px 6px;
  justify-content: center;
}

.swatch-line {
  height: 2px;
  border-radius: 1px;
}

.swatch-label {
  font-family: var(--font-sans);
  font-size: 9.5px;
  font-weight: 500;
  color: var(--color-ink-3);
}

.swatch-dots {
  display: flex;
  gap: 3px;
  justify-content: center;
  padding-bottom: 8px;
}
.swatch-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
</style>
