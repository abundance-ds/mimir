<template>
  <div>
    <!-- Text size -->
    <div class="setting-row">
      <div class="setting-label">
        Text size
        <span class="setting-desc">Font size for the editor</span>
      </div>
      <div class="stepper">
        <button
          class="stepper-btn"
          :disabled="settings.editorFontSize <= 12"
          @click="settings.set('editorFontSize', settings.editorFontSize - 1)"
        >
          <IconMinus :size="10" />
        </button>
        <span class="stepper-value">{{ settings.editorFontSize }}px</span>
        <button
          class="stepper-btn"
          :disabled="settings.editorFontSize >= 24"
          @click="settings.set('editorFontSize', settings.editorFontSize + 1)"
        >
          <IconPlus :size="10" />
        </button>
      </div>
    </div>

    <!-- Font -->
    <div class="setting-row">
      <div class="setting-label">
        Font
        <span class="setting-desc">Typeface for Markdown editing</span>
      </div>
      <div style="position: relative" ref="dropdownRef">
        <button class="dropdown-trigger" @click="fontOpen = !fontOpen">
          <span>{{ activeFont.label }}</span>
          <IconChevronDown :size="11" />
        </button>
        <div v-if="fontOpen" class="dropdown-menu">
          <button
            v-for="f in EDITOR_FONTS"
            :key="f.key"
            class="dropdown-item"
            :class="settings.editorFontFamily === f.key ? 'text-accent font-medium' : ''"
            :style="{ fontFamily: f.family }"
            @click="settings.set('editorFontFamily', f.key); fontOpen = false"
          >
            <span>{{ f.label }}</span>
            <IconCheck v-if="settings.editorFontFamily === f.key" :size="12" class="text-accent" />
          </button>
        </div>
      </div>
    </div>

    <!-- Toolbar -->
    <div class="setting-row">
      <div class="setting-label">
        Toolbar
        <span class="setting-desc">Show formatting toolbar above editor</span>
      </div>
      <button
        class="toggle-switch"
        :class="{ 'toggle-on': settings.editorToolbarMode !== 'none' }"
        @click="settings.set('editorToolbarMode', settings.editorToolbarMode === 'none' ? 'top' : 'none')"
      >
        <span class="toggle-knob"></span>
      </button>
    </div>

    <!-- Word wrap -->
    <div class="setting-row">
      <div class="setting-label">
        Word wrap
        <span class="setting-desc">Wrap long lines to fit the viewport</span>
      </div>
      <button
        class="toggle-switch"
        :class="{ 'toggle-on': settings.editorWordWrap }"
        @click="settings.set('editorWordWrap', !settings.editorWordWrap)"
      >
        <span class="toggle-knob"></span>
      </button>
    </div>

    <!-- Line width -->
    <div class="setting-row">
      <div class="setting-label">
        Line width
        <span class="setting-desc">Maximum content width</span>
      </div>
      <div class="segmented-control">
        <button
          v-for="opt in lineWidthOptions"
          :key="opt.value"
          class="segmented-btn"
          :class="{ 'segmented-active': settings.editorLineWidth === opt.value }"
          @click="settings.set('editorLineWidth', opt.value)"
        >{{ opt.label }}</button>
      </div>
    </div>

    <!-- Live preview -->
    <div class="setting-row">
      <div class="setting-label">
        Live preview
        <span class="setting-desc">Hide Markdown syntax when not editing a line</span>
      </div>
      <button
        class="toggle-switch"
        :class="{ 'toggle-on': settings.editorLivePreview }"
        @click="settings.set('editorLivePreview', !settings.editorLivePreview)"
      >
        <span class="toggle-knob"></span>
      </button>
    </div>

    <!-- Spell check -->
    <div class="setting-row">
      <div class="setting-label">
        Spell check
        <span class="setting-desc">Underline misspelled words</span>
      </div>
      <button
        class="toggle-switch"
        :class="{ 'toggle-on': settings.editorSpellCheck }"
        @click="settings.set('editorSpellCheck', !settings.editorSpellCheck)"
      >
        <span class="toggle-knob"></span>
      </button>
    </div>

    <!-- Auto-save -->
    <div class="setting-row last">
      <div class="setting-label">
        Auto-save
        <span class="setting-desc">Save changes automatically</span>
      </div>
      <button
        class="toggle-switch"
        :class="{ 'toggle-on': settings.editorAutoSave }"
        @click="settings.set('editorAutoSave', !settings.editorAutoSave)"
      >
        <span class="toggle-knob"></span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useSettingsStore } from '../../../stores/settings.js'
import { EDITOR_FONTS } from '../../../shared/fonts.js'
import { IconMinus, IconPlus, IconChevronDown, IconCheck } from '@tabler/icons-vue'

const settings = useSettingsStore()
const activeFont = computed(() => EDITOR_FONTS.find(f => f.key === settings.editorFontFamily) || EDITOR_FONTS[0])

const fontOpen = ref(false)
const dropdownRef = ref(null)

function onClickOutside(e) {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target)) fontOpen.value = false
}

onMounted(() => document.addEventListener('pointerdown', onClickOutside))
onUnmounted(() => document.removeEventListener('pointerdown', onClickOutside))

const lineWidthOptions = [
  { label: 'Normal', value: 'normal' },
  { label: 'Wide', value: 'wide' },
  { label: 'Off', value: 'off' },
]
</script>
