<template>
  <Teleport to="body">
    <Transition name="settings-fade">
      <div
        v-if="open"
        class="fixed inset-0 bg-black/30 z-[100] flex items-center justify-center"
        @click.self="$emit('close')"
      >
        <div
          ref="dialog"
          class="settings-dialog settings-card outline-none"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-dialog-title"
          tabindex="-1"
          @keydown="onDialogKeydown"
        >
          <!-- Sidebar nav -->
          <nav ref="settingsNav" class="settings-nav" aria-label="Settings sections" @keydown="onNavKeydown">
            <div class="nav-header">Settings</div>
            <template v-for="(group, gi) in navGroups" :key="gi">
              <div v-if="gi > 0" class="nav-separator" />
              <button
                v-for="item in group"
                :key="item.id"
                type="button"
                :data-settings-section="item.id"
                :aria-current="activeSection === item.id ? 'page' : undefined"
                class="nav-item"
                :class="activeSection === item.id ? 'nav-item-active' : ''"
                @click="activeSection = item.id"
              >
                <component :is="item.icon" :size="16" class="nav-icon" />
                <span class="nav-label">{{ item.label }}</span>
              </button>
            </template>
          </nav>

          <!-- Content -->
          <div class="settings-main">
            <div class="settings-header">
              <span id="settings-dialog-title" class="settings-title">{{ activeLabel }}</span>
              <button
                type="button"
                aria-label="Close settings"
                class="settings-close"
                @click="$emit('close')"
              >
                <IconX :size="14" />
              </button>
            </div>
            <div class="settings-body scrollbar-thin">
              <AppearanceSection v-if="activeSection === 'appearance'" />
              <EditorSection v-else-if="activeSection === 'editor'" />
              <AISection v-else-if="activeSection === 'ai'" />
              <ConnectionsSettingsSection v-else-if="activeSection === 'connections'" />
              <ScribeSettingsSection v-else-if="activeSection === 'scribe'" />
              <TrackerSettingsPanel v-else-if="activeSection === 'tracker'" />
              <GraphSettingsSection v-else-if="activeSection === 'graph'" />
              <ChatSettingsSection v-else-if="activeSection === 'chat'" />
              <LaunchersSection v-else-if="activeSection === 'launchers'" />
              <ShortcutsSection v-else-if="activeSection === 'shortcuts'" />
              <UpdatesSection v-else-if="activeSection === 'updates'" />
              <AboutSection v-else-if="activeSection === 'about'" />
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import './settings/settings-form.css'
import AppearanceSection from './settings/AppearanceSection.vue'
import EditorSection from './settings/EditorSection.vue'
import AISection from './settings/AISection.vue'
import ConnectionsSettingsSection from './settings/ConnectionsSettingsSection.vue'
import ScribeSettingsSection from './settings/ScribeSettingsSection.vue'
import TrackerSettingsPanel from './settings/TrackerSettingsPanel.vue'
import GraphSettingsSection from './settings/GraphSettingsSection.vue'
import ChatSettingsSection from './settings/ChatSettingsSection.vue'
import LaunchersSection from './settings/LaunchersSection.vue'
import ShortcutsSection from './settings/ShortcutsSection.vue'
import UpdatesSection from './settings/UpdatesSection.vue'
import AboutSection from './settings/AboutSection.vue'
import {
  IconX,
  IconPalette,
  IconPencil,
  IconSparkles,
  IconKeyboard,
  IconInfoCircle,
  IconTerminal2,
  IconTopologyStar3,
  IconMessages,
  IconMicrophone,
  IconActivityHeartbeat,
  IconRefresh,
  IconPlugConnected,
} from '@tabler/icons-vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  initialSection: { type: String, default: 'appearance' },
})
const emit = defineEmits(['close'])

const navGroups = [
  [
    { id: 'appearance', label: 'Appearance', icon: IconPalette },
    { id: 'editor',     label: 'Editor',     icon: IconPencil },
    { id: 'ai',         label: 'Models',     icon: IconSparkles },
    { id: 'connections', label: 'Connections', icon: IconPlugConnected },
    { id: 'scribe',     label: 'Scribe',     icon: IconMicrophone },
    { id: 'tracker',    label: 'Tracker',    icon: IconActivityHeartbeat },
    { id: 'graph',      label: 'Graph',      icon: IconTopologyStar3 },
    { id: 'chat',       label: 'Chat',       icon: IconMessages },
    { id: 'launchers',  label: 'CLI tools',  icon: IconTerminal2 },
  ],
  [
    { id: 'shortcuts',  label: 'Shortcuts',  icon: IconKeyboard },
    { id: 'updates',    label: 'Updates',    icon: IconRefresh },
    { id: 'about',      label: 'About',      icon: IconInfoCircle },
  ],
]

const navItems = navGroups.flat()

const activeSection = ref(mapSection(props.initialSection))
const activeLabel = computed(() => navItems.find(i => i.id === activeSection.value)?.label ?? '')
const dialog = ref(null)
const settingsNav = ref(null)
let previousFocus = null

watch(() => props.open, async (val) => {
  if (val) {
    previousFocus = document.activeElement
    if (props.initialSection) activeSection.value = mapSection(props.initialSection)
    await focusInitial()
  } else {
    restoreFocus()
  }
})

watch(() => props.initialSection, (section) => {
  if (props.open && section) {
    activeSection.value = mapSection(section)
    void focusInitial()
  }
})

function mapSection(section) {
  if (['appearance', 'general'].includes(section)) return 'appearance'
  if (['models', 'ai'].includes(section)) return 'ai'
  if (['connections', 'integrations'].includes(section)) return 'connections'
  if (['scribe', 'meetings', 'recording'].includes(section)) return 'scribe'
  if (['tracker', 'tracking', 'activity-tracking'].includes(section)) return 'tracker'
  if (['graph', 'knowledge', 'scopes'].includes(section)) return 'graph'
  if (['chat', 'chats'].includes(section)) return 'chat'
  if (['launchers', 'agents'].includes(section)) return 'launchers'
  if (['shortcuts'].includes(section)) return 'shortcuts'
  if (['updates', 'update'].includes(section)) return 'updates'
  if (['about', 'info'].includes(section)) return 'about'
  if (['editor', 'writing'].includes(section)) return 'editor'
  return 'appearance'
}

function onKeydown(e) {
  if (e.key === 'Escape' && props.open) {
    emit('close')
    e.preventDefault()
  }
}

function onDialogKeydown(event) {
  if (event.key !== 'Tab') return
  const focusable = focusableElements()
  if (!focusable.length) {
    event.preventDefault()
    dialog.value?.focus()
    return
  }
  const first = focusable[0]
  const last = focusable.at(-1)
  if (event.shiftKey && (document.activeElement === first || !dialog.value?.contains(document.activeElement))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function onNavKeydown(event) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  let index = navItems.findIndex(item => item.id === activeSection.value)
  if (event.key === 'Home') index = 0
  else if (event.key === 'End') index = navItems.length - 1
  else {
    const delta = event.key === 'ArrowDown' ? 1 : -1
    index = (index + delta + navItems.length) % navItems.length
  }
  activeSection.value = navItems[index].id
  nextTick(() => settingsNav.value
    ?.querySelector(`[data-settings-section="${navItems[index].id}"]`)
    ?.focus())
}

async function focusInitial() {
  await nextTick()
  if (!props.open) return
  const selected = settingsNav.value
    ?.querySelector(`[data-settings-section="${activeSection.value}"]`)
  ;(selected || dialog.value)?.focus()
}

function focusableElements() {
  if (!dialog.value) return []
  return Array.from(dialog.value.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )).filter(element => element.getAttribute('aria-hidden') !== 'true')
}

function restoreFocus() {
  const target = previousFocus
  previousFocus = null
  if (target && target.isConnected && typeof target.focus === 'function') {
    nextTick(() => target.focus())
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  if (props.open) {
    previousFocus = document.activeElement
    void focusInitial()
  }
})
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
  restoreFocus()
})
</script>

<style scoped>
.settings-dialog {
  width: min(760px, calc(100vw - 24px));
  height: min(640px, calc(100vh - 24px));
  background: var(--color-surface);
  border: 1px solid var(--color-rule);
  border-radius: 10px;
  display: flex;
  overflow: hidden;
}

/* ── Sidebar nav ── */

.settings-nav {
  width: 172px;
  flex-shrink: 0;
  background: var(--color-chrome);
  border-right: 1px solid var(--color-rule-light);
  padding: 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 6px;
  border: none;
  background: none;
}
.nav-item:hover:not(.nav-item-active) {
  background: var(--color-chrome-mid);
}

.nav-item-active {
  background: var(--color-accent-soft);
}

.nav-icon {
  flex-shrink: 0;
  color: var(--color-ink-3);
}
.nav-item-active .nav-icon {
  color: var(--color-accent);
}

.nav-label {
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 500;
  color: var(--color-ink-2);
}
.nav-item-active .nav-label {
  color: var(--color-accent);
  font-weight: 600;
}

.nav-header {
  font-family: var(--font-sans);
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1.8px;
  color: var(--color-ink-3);
  padding: 4px 12px;
  margin-bottom: 6px;
}

.nav-separator {
  height: 1px;
  background: var(--color-rule);
  margin: 6px 12px;
}

/* ── Content area ── */

.settings-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.settings-header {
  height: 44px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  border-bottom: 1px solid var(--color-rule-light);
}

.settings-title {
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 600;
  color: var(--color-ink);
  letter-spacing: 0.2px;
}

.settings-close {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: var(--color-ink-3);
  border: none;
  background: none;
}
.settings-close:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.settings-body {
  flex: 1;
  overflow-y: auto;
  padding: 24px 28px;
}

</style>
