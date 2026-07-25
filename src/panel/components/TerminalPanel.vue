<template>
  <div
    ref="panelEl"
    class="tp"
    :class="`tp-${dock}`"
    :style="dock === 'side' ? { width: sideWidth + 'px' } : { height: height + 'px' }"
  >
    <!-- Invisible drag handle overlaid on top edge -->
    <div
      class="tp-drag"
      :class="{ active: dragging }"
      @pointerdown="onPointerDown"
    />

    <!-- Tab bar — ultra-minimal -->
    <div class="tp-bar">
      <div class="tp-tabs">
        <button
          v-for="(tab, i) in tabs"
          :key="tab.id"
          class="tp-tab"
          :class="{ 'is-active': i === activeIndex, 'tp-tab-dragging': dragIndex === i }"
          @click="onTabClick(i)"
          @contextmenu.prevent="openContextMenu(i, $event)"
          @pointerdown.left="onTabPointerDown(i, $event)"
        >
          <input
            v-if="renameIndex === i"
            v-model="renameValue"
            class="tp-rename"
            autocorrect="off"
            autocapitalize="off"
            @keydown.enter="commitRename"
            @keydown.escape="cancelRename"
            @blur="commitRename"
            @click.stop
            @contextmenu.stop
            @pointerdown.stop
          />
          <template v-else>
            <span class="tp-tab-label">{{ tab.label }}</span>
            <span
              class="tp-tab-x"
              @click.stop="closeTab(i)"
            >&times;</span>
          </template>
        </button>
      </div>

      <button
        class="tp-btn ml-0.5"
        title="New terminal"
        @click="addTab()"
      >
        <IconPlus :size="12" />
      </button>

      <button
        class="tp-btn mr-1"
        title="Hide terminal"
        @click="emit('close')"
      >
        <IconChevronDown :size="13" />
      </button>
    </div>

    <!-- Context menu -->
    <Teleport to="body">
      <div
        v-if="ctxMenu.open"
        class="tp-ctx"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      >
        <button class="tp-ctx-item" @click="ctxRename">Rename</button>
        <button class="tp-ctx-item" @click="ctxClose">Close</button>
      </div>
    </Teleport>

    <!-- Terminal surfaces -->
    <div class="tp-surfaces">
      <div
        v-for="(tab, i) in tabs"
        :key="tab.id"
        v-show="i === activeIndex"
        :ref="el => { if (el) surfaceRefs[tab.id] = el }"
        class="absolute inset-0 pt-0.5 pl-2"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { IconChevronDown, IconPlus } from '@tabler/icons-vue'
import { useVerticalResize } from '../../shared/composables/useVerticalResize.js'
import { useSettingsStore } from '../../stores/settings.js'
import { useSessionStore } from '../../stores/panel/sessions.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  dock: { type: String, default: 'bottom' },
  sideWidth: { type: Number, default: 440 },
  defaultCwd: { type: String, default: '' },
})
const emit = defineEmits(['close'])

const settingsStore = useSettingsStore()
const sessionStore = useSessionStore()
const { height, dragging, onPointerDown } = useVerticalResize(
  settingsStore.terminalHeight ?? 220,
  { min: 100, max: 600 },
)

watch(dragging, (isDragging) => {
  if (!isDragging) settingsStore.set('terminalHeight', height.value)
})

const tabs = ref([])
const activeIndex = ref(0)
const surfaceRefs = ref({})
const panelEl = ref(null)
let nextTabId = 1

const terminalFontSize = ref(settingsStore.mimTerminalFontSize ?? 12)

// ── Context menu ──
const ctxMenu = ref({ open: false, x: 0, y: 0, index: -1 })

function openContextMenu(i, e) {
  activeIndex.value = i
  ctxMenu.value = { open: true, x: e.clientX, y: e.clientY, index: i }
  setTimeout(() => document.addEventListener('pointerdown', closeContextMenu), 0)
}

function closeContextMenu(e) {
  if (e && e.target.closest('.tp-ctx')) return
  ctxMenu.value.open = false
  document.removeEventListener('pointerdown', closeContextMenu)
}

function ctxRename() {
  const i = ctxMenu.value.index
  document.removeEventListener('pointerdown', closeContextMenu)
  ctxMenu.value.open = false
  nextTick(() => startRename(i))
}

function ctxClose() {
  const i = ctxMenu.value.index
  document.removeEventListener('pointerdown', closeContextMenu)
  ctxMenu.value.open = false
  closeTab(i)
}

// ── Rename ──
const renameIndex = ref(-1)
const renameValue = ref('')

function startRename(i) {
  renameIndex.value = i
  renameValue.value = tabs.value[i].label
  nextTick(() => {
    const input = document.querySelector('.tp-rename')
    if (input) { input.focus(); input.select() }
  })
}

function commitRename() {
  if (renameIndex.value < 0) return
  const trimmed = renameValue.value.trim()
  if (trimmed) tabs.value[renameIndex.value].label = trimmed
  renameIndex.value = -1
}

function cancelRename() {
  renameIndex.value = -1
}

// ── Lightweight drag reorder ──
const dragIndex = ref(-1)
let dragStartX = 0
let dragActive = false

function onTabPointerDown(i, e) {
  if (renameIndex.value >= 0) return
  dragIndex.value = i
  dragStartX = e.clientX
  dragActive = false
  document.addEventListener('pointermove', onTabDragMove)
  document.addEventListener('pointerup', onTabDragEnd)
}

function onTabDragMove(e) {
  const dx = e.clientX - dragStartX
  if (!dragActive && Math.abs(dx) < 5) return
  dragActive = true

  const tabEls = Array.from(document.querySelectorAll('.tp-tab'))
  for (let i = 0; i < tabEls.length; i++) {
    if (i === dragIndex.value) continue
    const rect = tabEls[i].getBoundingClientRect()
    const mid = rect.left + rect.width / 2
    if (dragIndex.value < i && e.clientX > mid) {
      const moved = tabs.value.splice(dragIndex.value, 1)[0]
      tabs.value.splice(i, 0, moved)
      if (activeIndex.value === dragIndex.value) activeIndex.value = i
      else if (activeIndex.value > dragIndex.value && activeIndex.value <= i) activeIndex.value--
      dragIndex.value = i
      dragStartX = e.clientX
      break
    } else if (dragIndex.value > i && e.clientX < mid) {
      const moved = tabs.value.splice(dragIndex.value, 1)[0]
      tabs.value.splice(i, 0, moved)
      if (activeIndex.value === dragIndex.value) activeIndex.value = i
      else if (activeIndex.value >= i && activeIndex.value < dragIndex.value) activeIndex.value++
      dragIndex.value = i
      dragStartX = e.clientX
      break
    }
  }
}

function onTabDragEnd() {
  dragIndex.value = -1
  dragActive = false
  document.removeEventListener('pointermove', onTabDragMove)
  document.removeEventListener('pointerup', onTabDragEnd)
}

function onTabClick(i) {
  if (dragActive) return
  activeIndex.value = i
}

function selectTab(index) {
  if (!tabs.value.length) return
  activeIndex.value = (index + tabs.value.length) % tabs.value.length
  nextTick(() => focus())
}

function nextTab() {
  selectTab(activeIndex.value + 1)
}

function previousTab() {
  selectTab(activeIndex.value - 1)
}

function getDefaultShell() {
  const platform = navigator.platform || ''
  if (/Mac/.test(platform)) return { cmd: '/bin/zsh', args: ['-l'] }
  if (/Win/.test(platform)) return { cmd: 'powershell.exe', args: ['-NoLogo'] }
  return { cmd: '/bin/bash', args: ['-l'] }
}

function getProjectCwd() {
  const project = sessionStore.activeProject
  return project?.workspacePath || project?.path || null
}

function getXtermTheme() {
  const cs = getComputedStyle(document.documentElement)
  const get = (v) => cs.getPropertyValue(v).trim()
  const accent = get('--color-accent') || '#c05d3c'
  return {
    background: get('--color-surface') || '#ffffff',
    foreground: get('--color-ink-2') || '#4a4a44',
    cursor: accent,
    cursorAccent: get('--color-surface') || '#ffffff',
    selectionBackground: accent + '33',
    selectionForeground: undefined,
    black: '#1a1a18',
    red: '#c05d3c',
    green: '#5e8b3e',
    yellow: '#d4a520',
    blue: '#4a7c9b',
    magenta: '#7c4dff',
    cyan: '#5a9e8f',
    white: '#e0e0dc',
    brightBlack: '#6a6a64',
    brightRed: '#e07070',
    brightGreen: '#7cc68a',
    brightYellow: '#f0c040',
    brightBlue: '#6ea8c8',
    brightMagenta: '#b39dff',
    brightCyan: '#7cc6b8',
    brightWhite: '#f5f5f0',
  }
}

const _isMac = /Mac/.test(navigator.platform || '')

function handleTerminalKeyEvent(event, tab) {
  if (event.type !== 'keydown') return true
  if (tab.ptyId == null) return true
  if (!_isMac) return true

  const { key, metaKey, altKey, ctrlKey, shiftKey } = event

  if (metaKey && !altKey && !ctrlKey && key === 'ArrowLeft') {
    event.preventDefault()
    writeToPty(tab.ptyId, '\x01')
    return false
  }
  if (metaKey && !altKey && !ctrlKey && key === 'ArrowRight') {
    event.preventDefault()
    writeToPty(tab.ptyId, '\x05')
    return false
  }
  if (metaKey && !altKey && !ctrlKey && key === 'Backspace') {
    event.preventDefault()
    writeToPty(tab.ptyId, '\x15')
    return false
  }
  if (metaKey && !altKey && !ctrlKey && !shiftKey && key === 'k') {
    event.preventDefault()
    writeToPty(tab.ptyId, '\x0c')
    return false
  }
  if (shiftKey && !metaKey && !altKey && !ctrlKey && key === 'Enter') {
    event.preventDefault()
    writeToPty(tab.ptyId, '\x16\x0a')
    return false
  }

  return true
}

async function writeToPty(ptyId, data) {
  if (data.length < 2048) {
    await invoke('pty_write', { id: ptyId, data })
    return
  }
  const chunks = []
  let start = 0
  while (start < data.length) {
    let end = Math.min(start + 2048, data.length)
    if (end < data.length) {
      const nl = data.lastIndexOf('\n', end)
      if (nl > start) end = nl + 1
    }
    chunks.push(data.slice(start, end))
    start = end
  }
  for (let ci = 0; ci < chunks.length; ci++) {
    await invoke('pty_write', { id: ptyId, data: chunks[ci] })
    if (ci < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 10))
    }
  }
}

async function initXterm(tab) {
  const surface = surfaceRefs.value[tab.id]
  if (!surface) return

  const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-web-links'),
    import('@xterm/xterm/css/xterm.css'),
  ])

  const fitAddon = new FitAddon()
  const terminal = new Terminal({
    theme: getXtermTheme(),
    fontFamily: 'IBM Plex Mono, ui-monospace, monospace',
    fontSize: terminalFontSize.value,
    scrollback: 10000,
    cursorBlink: true,
    cursorStyle: 'bar',
    allowProposedApi: true,
  })

  terminal.loadAddon(fitAddon)
  terminal.loadAddon(new WebLinksAddon())
  terminal.open(surface)
  fitAddon.fit()
  terminal.attachCustomKeyEventHandler((event) => handleTerminalKeyEvent(event, tab))

  tab.terminal = terminal
  tab.fitAddon = fitAddon

  const observer = new ResizeObserver(() => {
    const rect = surface.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    fitAddon.fit()
    if (tab.ptyId != null && terminal.cols > 0 && terminal.rows > 0) {
      invoke('pty_resize', { id: tab.ptyId, cols: terminal.cols, rows: terminal.rows }).catch(() => {})
    }
  })
  observer.observe(surface)
  tab.resizeObserver = observer

  const { cmd, args } = tab.command
    ? { cmd: tab.command, args: tab.args || [] }
    : getDefaultShell()

  try {
    const ptyId = await invoke('pty_spawn', {
      command: cmd,
      args,
      cwd: tab.cwd || props.defaultCwd || getProjectCwd(),
      env: tab.env || {},
      cols: terminal.cols,
      rows: terminal.rows,
    })
    tab.ptyId = ptyId

    // TODO: remove after diagnosing dead key bug (~ + space → s)
    terminal.onData((data) => {
      const bytes = [...data].map(c => c.charCodeAt(0).toString(16).padStart(2, '0'))
      if (bytes.some(b => ['7e', '73', '6e', '1b', '20'].includes(b))) {
        console.log('[term-debug] onData', { data: JSON.stringify(data), bytes })
      }
    })
    if (terminal.textarea) {
      for (const evtType of ['compositionstart', 'compositionupdate', 'compositionend']) {
        terminal.textarea.addEventListener(evtType, (e) => {
          console.log(`[term-debug] ${evtType}`, { data: e.data, textareaValue: terminal.textarea.value })
        })
      }
    }

    const dataDisposable = terminal.onData((data) => {
      writeToPty(ptyId, data)
    })
    tab.dataDisposable = dataDisposable

    const unlistenOutput = await listen(`pty-output-${ptyId}`, (event) => {
      terminal.write(event.payload)
    })
    tab.unlistenOutput = unlistenOutput

    const unlistenExit = await listen(`pty-exit-${ptyId}`, () => {
      terminal.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n')
      tab.ptyId = null
    })
    tab.unlistenExit = unlistenExit
  } catch (err) {
    terminal.write(`\x1b[31mFailed to spawn terminal: ${err}\x1b[0m\r\n`)
  }
}

async function addTab({ command, args, cwd, env, label } = {}) {
  const id = nextTabId++
  const tab = {
    id,
    label: label || `Terminal ${id}`,
    ptyId: null,
    terminal: null,
    fitAddon: null,
    resizeObserver: null,
    dataDisposable: null,
    unlistenOutput: null,
    unlistenExit: null,
    command: command || null,
    args: args || [],
    cwd: cwd || null,
    env: env || null,
  }
  tabs.value.push(tab)
  activeIndex.value = tabs.value.length - 1

  await nextTick()
  await initXterm(tab)
}

function closeTab(index) {
  const tab = tabs.value[index]
  if (!tab) return

  if (tab.ptyId != null) {
    invoke('pty_kill', { id: tab.ptyId }).catch(() => {})
  }
  if (tab.unlistenOutput) tab.unlistenOutput()
  if (tab.unlistenExit) tab.unlistenExit()
  if (tab.dataDisposable) tab.dataDisposable.dispose()
  if (tab.resizeObserver) tab.resizeObserver.disconnect()
  if (tab.terminal) tab.terminal.dispose()

  delete surfaceRefs.value[tab.id]
  tabs.value.splice(index, 1)

  if (tabs.value.length === 0) {
    emit('close')
  } else {
    activeIndex.value = Math.min(activeIndex.value, tabs.value.length - 1)
    nextTick(() => focus())
  }
}

function focus() {
  const tab = tabs.value[activeIndex.value]
  if (tab?.terminal) tab.terminal.focus()
}

function setTerminalFontSize(size) {
  const next = Math.max(9, Math.min(28, size))
  terminalFontSize.value = next
  settingsStore.set('mimTerminalFontSize', next)
  for (const tab of tabs.value) {
    if (!tab.terminal) continue
    tab.terminal.options.fontSize = next
    tab.fitAddon?.fit()
    if (tab.ptyId != null && tab.terminal.cols > 0 && tab.terminal.rows > 0) {
      invoke('pty_resize', { id: tab.ptyId, cols: tab.terminal.cols, rows: tab.terminal.rows }).catch(() => {})
    }
  }
}

function zoomIn() {
  setTerminalFontSize(terminalFontSize.value + 1)
}

function zoomOut() {
  setTerminalFontSize(terminalFontSize.value - 1)
}

function hasFocus() {
  const tab = tabs.value[activeIndex.value]
  return Boolean(
    panelEl.value?.contains(document.activeElement) ||
    tab?.terminal?.element?.contains(document.activeElement),
  )
}

watch(activeIndex, () => {
  nextTick(() => {
    const tab = tabs.value[activeIndex.value]
    if (tab?.fitAddon && tab?.terminal) {
      const surface = surfaceRefs.value[tab.id]
      if (surface) {
        const rect = surface.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          tab.fitAddon.fit()
        }
      }
    }
  })
})

let unlistenTheme = null
async function setupThemeListener() {
  try {
    unlistenTheme = await listen('mim://theme-changed', () => {
      const theme = getXtermTheme()
      for (const tab of tabs.value) {
        if (tab.terminal) tab.terminal.options.theme = theme
      }
    })
  } catch { /* not in Tauri */ }
}

let initialized = false
watch(() => props.visible, (isVisible) => {
  if (isVisible && !initialized) {
    initialized = true
    addTab()
  } else if (isVisible && tabs.value.length === 0) {
    addTab()
  }
  if (isVisible) {
    nextTick(() => {
      const tab = tabs.value[activeIndex.value]
      if (tab?.fitAddon) {
        const surface = surfaceRefs.value[tab.id]
        if (surface) {
          const rect = surface.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) tab.fitAddon.fit()
        }
      }
    })
  }
}, { immediate: true })

onMounted(() => {
  setupThemeListener()
})

onBeforeUnmount(() => {
  for (const tab of tabs.value) {
    if (tab.ptyId != null) invoke('pty_kill', { id: tab.ptyId }).catch(() => {})
    if (tab.unlistenOutput) tab.unlistenOutput()
    if (tab.unlistenExit) tab.unlistenExit()
    if (tab.dataDisposable) tab.dataDisposable.dispose()
    if (tab.resizeObserver) tab.resizeObserver.disconnect()
    if (tab.terminal) tab.terminal.dispose()
  }
  if (unlistenTheme) unlistenTheme()
})

function closeActiveTab() {
  closeTab(activeIndex.value)
}

async function pasteText(text = '') {
  const tab = tabs.value[activeIndex.value]
  if (!tab?.ptyId || !text) return false
  await writeToPty(tab.ptyId, text)
  focus()
  return true
}

defineExpose({ focus, addTab, closeActiveTab, hasFocus, zoomIn, zoomOut, nextTab, previousTab, pasteText })
</script>

<style scoped>
.tp {
  display: flex;
  flex-direction: column;
  flex: none;
  position: relative;
  overflow: hidden;
  background: var(--color-surface);
  border-top: 1px solid var(--color-rule-light);
}

.tp-side {
  height: 100%;
  min-width: 260px;
  max-width: 72vw;
  border-top: none;
  border-right: 1px solid var(--color-rule-light);
}

.tp-side .tp-drag {
  display: none;
}

/* Drag handle: invisible overlay, only accent line on hover/drag */
.tp-drag {
  position: absolute;
  top: -3px;
  left: 0;
  right: 0;
  height: 8px;
  cursor: row-resize;
  z-index: 10;
}
.tp-drag::after {
  content: '';
  position: absolute;
  left: 0; right: 0;
  bottom: 3px;
  height: 2px;
  background: var(--color-accent);
  opacity: 0;
  transition: opacity 100ms;
}
.tp-drag:hover::after,
.tp-drag.active::after {
  opacity: 1;
}

/* Tab bar: minimal strip */
.tp-bar {
  display: flex;
  align-items: stretch;
  height: 27px;
  padding-left: 6px;
  background: var(--color-chrome-mid);
  flex-shrink: 0;
}

.tp-tabs {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
}

/* Tab: fill available width, active connects to surface below */
.tp-tab {
  display: flex;
  align-items: center;
  flex: 1 1 0;
  min-width: 76px;
  max-width: 220px;
  height: 27px;
  padding: 0 9px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--color-ink-3);
  background: transparent;
  border: none;
  border-bottom: 1px solid transparent;
}
.tp-tab:hover {
  color: var(--color-ink-2);
}
.tp-tab.is-active {
  color: var(--color-ink-2);
  font-weight: 500;
  background: var(--color-surface);
  border-bottom-color: var(--color-surface);
  margin-bottom: -1px;
}

.tp-tab-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-tab-x {
  font-size: 14px;
  line-height: 1;
  color: var(--color-ink-3);
  opacity: 0;
  flex-shrink: 0;
}
.tp-tab:hover .tp-tab-x,
.tp-tab.is-active .tp-tab-x { opacity: 1; }
.tp-tab-x:hover { color: var(--color-ink-2); }

/* Utility buttons (+ and chevron) */
.tp-btn {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  align-self: center;
  border-radius: 3px;
  color: var(--color-ink-3);
  background: none;
  border: none;
}
.tp-btn:hover {
  background: var(--color-chrome);
  color: var(--color-ink-2);
}

/* Rename input */
.tp-rename {
  font: inherit;
  font-size: 9.5px;
  color: var(--color-ink);
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--color-accent);
  outline: none;
  padding: 0;
  width: 72px;
  min-width: 0;
}

/* Drag state */
.tp-tab-dragging {
  opacity: 0.5;
}

/* Terminal surfaces */
.tp-surfaces {
  flex: 1;
  position: relative;
  background: var(--color-surface);
  min-height: 0;
  border-top: 1px solid var(--color-rule-light);
}

/* Context menu */
.tp-ctx {
  position: fixed;
  z-index: 9999;
  min-width: 120px;
  padding: 4px;
  background: var(--color-surface);
  border: 1px solid var(--color-rule);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
}

.tp-ctx-item {
  display: block;
  width: 100%;
  height: 26px;
  padding: 0 8px;
  border-radius: 4px;
  font-family: var(--font-sans);
  font-size: 11.5px;
  color: var(--color-ink-2);
  text-align: left;
  background: none;
  border: none;
}
.tp-ctx-item:hover {
  background: var(--color-accent-soft);
  color: var(--color-ink);
}
</style>
