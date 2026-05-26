<template>
  <div class="tool-call" :class="{ 'is-pending': isPending }">
    <div v-if="isPending" class="approval-card">
      <div class="approval-head">
        <span class="tool-icon" :class="iconClass">
          <i :class="'ti ' + iconTi" style="font-size: 12px" />
        </span>
        <span class="tool-label">{{ label }}</span>
        <span class="approval-risk" :class="'risk-' + riskLevel">{{ riskLevel }}</span>
      </div>

      <p class="approval-desc">{{ description }}</p>

      <details v-if="hasArgs" class="approval-args-wrap" :open="riskLevel === 'high'">
        <summary class="approval-args-toggle">Arguments</summary>
        <pre class="approval-args">{{ formattedArgs }}</pre>
      </details>

      <div class="approval-actions">
        <button class="approval-btn btn-always" @click="alwaysAllow">
          {{ isPathApproval ? 'Allow folder' : 'Always allow' }}
        </button>
        <div class="approval-actions-right">
          <button class="approval-btn btn-decline" @click="decline">Decline</button>
          <button class="approval-btn btn-accept" @click="accept">
            Accept<kbd class="approval-kbd">⏎</kbd>
          </button>
        </div>
      </div>
    </div>

    <IssueCard v-else-if="renderMode === 'issue_card'" :data="toolOutput" />

    <div v-else>
      <div class="tool-line" :class="{ 'is-skill': isSkill }" @click="expanded = !expanded">
        <span v-if="toolStatus === 'running'" class="tool-pending-dots"><span /><span /><span /></span>
        <span v-else-if="toolStatus === 'error'" class="tool-status-icon tool-status-error">✕</span>
        <span v-else-if="toolStatus === 'done'" class="tool-status-icon tool-status-check">✓</span>
        <component :is="iconComponent" :size="12" class="tool-icon-svg" />
        <span class="tool-label-text">{{ displayLabel }}</span>
        <span v-if="context" class="tool-context" :class="{ 'tool-context-link': filePath }" @click.stop="filePath && openFile()" :title="filePath || ''">{{ context }}</span>
        <template v-if="proposal">
          <span class="tool-delta"><span class="text-add">+{{ proposalDelta.added }}</span><span class="text-rem">-{{ proposalDelta.removed }}</span></span>
          <span v-if="proposal.status === 'accepted'" class="tool-proposal-status text-add">✓</span>
          <span v-else-if="proposal.status === 'rejected'" class="tool-proposal-status text-rem">✕</span>
          <span v-else-if="proposal.status === 'failed'" class="tool-proposal-status text-rem">!</span>
          <span v-else-if="proposal.status === 'pending'" class="tool-proposal-status tool-proposal-pending" />
        </template>
      </div>
      <div class="tool-detail" :class="{ 'is-expanded': expanded }">
        <div class="tool-detail-inner">
          <template v-if="expanded">
            <div class="tool-detail-label">Input</div>
            <pre class="tool-detail-code">{{ formattedInput }}</pre>
            <template v-if="toolOutput">
              <div class="tool-detail-label">Output</div>
              <pre class="tool-detail-code tool-detail-output">{{ truncatedOutput }}</pre>
            </template>
            <div v-if="errorText" class="tool-detail-error">{{ errorText }}</div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue'
import IssueCard from './board/IssueCard.vue'
import { useChatStore } from '../../stores/panel/chat.js'
import { useSessionStore } from '../../stores/panel/sessions.js'
import { getToolMeta } from '../../services/ai/tools/gate.js'
import { getToolLabel, getToolIcon, getToolContext, getToolFilePath, isSkillTool } from '../../stores/panel/helpers.js'
import { computeLineDelta } from '../../shared/lineDelta.js'
import { IconEye, IconPencil, IconFilePlus, IconFolder, IconTerminal2, IconSearch, IconBook, IconSparkles, IconFile, IconList, IconMessageCircle, IconWorld, IconFileText, IconLayout } from '@tabler/icons-vue'

const props = defineProps({
  part: { type: Object, required: true },
})

const chat = useChatStore()
const sessionStore = useSessionStore()

const toolName = computed(() => props.part.toolName || props.part.type?.replace(/^tool-/, '') || 'tool')
const expanded = ref(false)

const label = computed(() => toolName.value)

const iconClass = computed(() => {
  const name = toolName.value
  if (name.startsWith('read') || name.startsWith('search') || name.startsWith('check') || name.startsWith('get') || name.startsWith('list') || name.startsWith('show')) return 'read'
  if (name.startsWith('write') || name.startsWith('propose') || name.startsWith('create') || name.startsWith('edit') || name.startsWith('import') || name.startsWith('annotate')) return 'write'
  if (name.startsWith('shell')) return 'run'
  return 'default'
})

const iconTi = computed(() => {
  const cls = iconClass.value
  if (cls === 'read') return 'ti-eye'
  if (cls === 'write') return 'ti-file-code'
  if (cls === 'run') return 'ti-terminal-2'
  return 'ti-wand'
})

const pendingApproval = computed(() => {
  const session = sessionStore.activeSession
  if (!session) return null
  const pending = chat.getPendingApproval(session.id)
  if (!pending) return null
  if (pending.toolName !== toolName.value) return null
  if (pending.meta?.toolCallId && props.part.toolCallId && pending.meta.toolCallId !== props.part.toolCallId) return null
  const state = props.part.state || props.part.status
  if (state === 'result' || state === 'output-available') return null
  return pending
})

const isPending = computed(() => Boolean(pendingApproval.value))
const riskLevel = computed(() => pendingApproval.value?.meta?.risk || 'low')
const isPathApproval = computed(() => pendingApproval.value?.meta?.category === 'path-access')

const description = computed(() => {
  const pending = pendingApproval.value
  if (!pending) return ''
  if (isPathApproval.value) {
    const path = pending.args?.path || ''
    const short = path.length > 50 ? '...' + path.slice(-47) : path
    return `Access path outside project: ${short}`
  }
  if (toolName.value === 'shell' && pending.args?.command) {
    const cmd = pending.args.command
    return `Shell: ${cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd}`
  }
  const base = getToolMeta(toolName.value).description || toolName.value
  const args = pending.args || {}
  if (args.path) return `${base} — ${args.path}`
  if (args.query) return `${base} — "${args.query}"`
  return base
})

const hasArgs = computed(() => {
  const args = pendingApproval.value?.args
  return args && Object.keys(args).length > 0
})

const formattedArgs = computed(() => {
  try {
    return JSON.stringify(pendingApproval.value?.args || {}, null, 2)
  } catch {
    return String(pendingApproval.value?.args)
  }
})

const toolInput = computed(() => props.part.input || props.part.args || {})
const toolOutput = computed(() => props.part.output || props.part.result)
const errorText = computed(() => props.part.errorText || (props.part.state === 'output-error' ? String(props.part.output || '') : ''))
const displayLabel = computed(() => getToolLabel(toolName.value))
const context = computed(() => getToolContext(toolName.value, toolInput.value))
const filePath = computed(() => getToolFilePath(toolName.value, toolInput.value))
const isSkill = computed(() => isSkillTool(toolName.value))

const toolStatus = computed(() => {
  const state = props.part.state || props.part.status
  if (state === 'input-streaming' || state === 'input-available') return 'running'
  if (state === 'output-error') return 'error'
  if (state === 'output-available') {
    const out = props.part.output
    if (out && typeof out === 'object' && 'error' in out) return 'error'
    return 'done'
  }
  return 'pending'
})

const ICON_MAP = {
  eye: IconEye,
  pencil: IconPencil,
  'file-plus': IconFilePlus,
  folder: IconFolder,
  terminal: IconTerminal2,
  search: IconSearch,
  book: IconBook,
  sparkle: IconSparkles,
  file: IconFile,
  list: IconList,
  'message-circle': IconMessageCircle,
  globe: IconWorld,
  'file-text': IconFileText,
  layout: IconLayout,
}

const iconComponent = computed(() => ICON_MAP[getToolIcon(toolName.value)] || IconFile)

const proposal = computed(() => {
  const out = toolOutput.value
  if (!out) return null
  let parsed = out
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed) } catch { return null } }
  if (!parsed?.proposalId) return null
  const session = sessionStore.activeSession
  return session?.proposals?.find(p => p.id === parsed.proposalId) || null
})

const proposalDelta = computed(() => {
  const p = proposal.value
  if (!p) return { added: 0, removed: 0 }
  return computeLineDelta(p.targetText || '', p.replacement || '')
})

const renderMode = computed(() => {
  const output = toolOutput.value
  if (output && typeof output === 'object' && output._render) return output._render
  return null
})

const formattedInput = computed(() => {
  const input = toolInput.value
  if (!input) return '{}'
  if (typeof input === 'string') return input
  return JSON.stringify(input, null, 2)
})

const truncatedOutput = computed(() => {
  const output = toolOutput.value
  if (!output) return ''
  if (typeof output === 'object') {
    const { base64, _dataUrl, ...safe } = output
    const str = JSON.stringify(safe, null, 2)
    return str.length > 2000 ? str.slice(0, 2000) + '\n... [truncated]' : str
  }
  const str = String(output)
  return str.length > 2000 ? str.slice(0, 2000) + '\n... [truncated]' : str
})

async function openFile() {
  if (!filePath.value) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const project = sessionStore.activeProject
    const p = filePath.value
    const absolute = p.startsWith('/') ? p : (project?.workspacePath || '') + '/' + p
    invoke('open_files_in_editor', { paths: [absolute] }).catch(() => {})
  } catch {}
}

function resolve(result) {
  const session = sessionStore.activeSession
  if (session) chat.resolveApproval(session.id, result)
}

function accept() {
  resolve({ approved: true, alwaysAllow: false })
}

function decline() {
  resolve({ approved: false, alwaysAllow: false })
}

function alwaysAllow() {
  resolve({ approved: true, alwaysAllow: true })
}

function onKeydown(e) {
  if (!isPending.value) return
  const tag = document.activeElement?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault()
    accept()
  }
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>

<style scoped>
.tool-call {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--color-ink-2);
}

.tool-call.is-pending {
  border: 1px solid var(--color-accent);
  border-left-width: 2px;
  border-radius: 6px;
  background: var(--color-accent-soft);
}
.tool-call.is-pending:hover { border-color: var(--color-accent); }

/* ---- Completed state: compact one-liner ---- */

.tool-line {
  display: flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 8px; border-radius: 4px;
  font-family: var(--font-mono); font-size: 11.5px;
  color: var(--color-ink-3); transition: background 0.12s;
}
.tool-line:hover { background: var(--color-chrome-mid); }

.tool-icon-svg { flex-shrink: 0; opacity: 0.6; }
.tool-label-text { font-weight: 500; color: var(--color-ink-2); white-space: nowrap; }
.tool-context {
  color: var(--color-ink-3); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; max-width: 45%;
}
.tool-context-link { text-underline-offset: 2px; }
.tool-context-link:hover { color: var(--color-accent); text-decoration: underline; }

.tool-delta { font-size: 10px; display: flex; gap: 4px; flex-shrink: 0; margin-left: auto; }
.tool-proposal-status { font-size: 10px; font-weight: 600; flex-shrink: 0; line-height: 1; }
.tool-proposal-pending {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--color-ink-3); flex-shrink: 0;
}

/* Skill accent treatment */
.tool-line.is-skill { background: var(--color-accent-soft); }
.tool-line.is-skill:hover { background: color-mix(in srgb, var(--color-accent) 14%, transparent); }
.tool-line.is-skill .tool-icon-svg { color: var(--color-accent); opacity: 0.85; }
.tool-line.is-skill .tool-label-text { color: var(--color-accent); }

/* Status indicators */
.tool-pending-dots { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.tool-pending-dots > span {
  width: 3.5px; height: 3.5px; border-radius: 50%;
  background: var(--color-ink-3);
  animation: tool-dot-pulse 1.2s ease-in-out infinite;
}
.tool-pending-dots > span:nth-child(2) { animation-delay: 0.15s; }
.tool-pending-dots > span:nth-child(3) { animation-delay: 0.3s; }
@keyframes tool-dot-pulse {
  0%, 60%, 100% { opacity: 0.2; }
  30% { opacity: 0.7; }
}
.tool-status-icon { font-size: 11px; line-height: 1; flex-shrink: 0; font-weight: 600; }
.tool-status-check { color: var(--color-ink-3); }
.tool-status-error { color: var(--color-accent-2); }

/* Expandable detail panel */
.tool-detail {
  display: grid; grid-template-rows: 0fr;
  transition: grid-template-rows 0.2s ease;
}
.tool-detail.is-expanded { grid-template-rows: 1fr; }
.tool-detail-inner { overflow: hidden; }
.tool-detail.is-expanded .tool-detail-inner {
  padding: 6px 10px;
  border-top: 1px solid var(--color-rule-light);
}
.tool-detail-label {
  font-family: var(--font-mono); font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--color-ink-3); margin-bottom: 3px; font-weight: 500;
}
.tool-detail-code {
  margin: 0 0 8px; padding: 6px 8px;
  background: var(--color-chrome); border: 1px solid var(--color-rule-light);
  border-radius: 4px; font-family: var(--font-mono); font-size: 10px;
  line-height: 1.4; white-space: pre-wrap; word-break: break-all;
  color: var(--color-ink-3);
}
.tool-detail-output { max-height: 128px; overflow-y: auto; }
.tool-detail-error {
  font-family: var(--font-mono); font-size: 10.5px;
  color: var(--color-accent-2); margin-top: 4px;
}

/* ---- Pending approval state ---- */

.tool-icon {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.tool-icon.read { background: var(--color-chrome-mid); color: var(--color-ink-3); }
.tool-icon.write { background: var(--color-chrome-mid); color: var(--color-ink-3); }
.tool-icon.run { background: var(--color-chrome-mid); color: var(--color-ink-3); }
.tool-icon.default { background: var(--color-chrome); color: var(--color-ink-2); }

.tool-label { flex: 1; }

.approval-card {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.approval-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.approval-head .tool-label {
  font-weight: 500;
  color: var(--color-ink);
}

.approval-risk {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 1px 6px;
  border-radius: 100px;
  flex-shrink: 0;
}
.risk-low {
  background: var(--color-chrome-mid);
  color: var(--color-ink-3);
}
.risk-medium {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.risk-high {
  background: var(--color-accent);
  color: var(--color-accent-ink, #fff);
}

.approval-desc {
  font-family: var(--font-sans);
  font-size: 12px;
  color: var(--color-ink-2);
  line-height: 1.4;
  margin: 0;
}

.approval-args-wrap {
  font-family: var(--font-mono);
  font-size: 10px;
}
.approval-args-toggle {
  font-family: var(--font-sans);
  font-size: 10px;
  color: var(--color-ink-3);
  list-style: none;
  padding: 2px 0;
}
.approval-args-toggle:hover {
  background: var(--color-chrome-mid);
  border-radius: 3px;
  color: var(--color-ink-2);
}
.approval-args-toggle::-webkit-details-marker { display: none; }
.approval-args-toggle::before {
  content: '▸ ';
}
[open] > .approval-args-toggle::before {
  content: '▾ ';
}

.approval-args {
  margin: 4px 0 0;
  padding: 6px 8px;
  background: var(--color-chrome-mid);
  border: 1px solid var(--color-rule-light);
  border-radius: 4px;
  font-size: 10px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 120px;
  overflow-y: auto;
  color: var(--color-ink-3);
}

.approval-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding-top: 2px;
}

.approval-actions-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.approval-btn {
  font-family: var(--font-sans);
  font-size: 10.5px;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: 4px;
}
.approval-btn:hover { opacity: 0.85; }

.btn-always {
  background: none;
  border: none;
  color: var(--color-ink-3);
  padding: 4px 4px;
  font-size: 10px;
}
.btn-always:hover { color: var(--color-ink-2); opacity: 1; background: var(--color-chrome-mid); border-radius: 3px; }

.btn-decline {
  background: var(--color-chrome-mid);
  color: var(--color-ink-2);
  border: 1px solid var(--color-rule);
}

.btn-accept {
  background: var(--color-accent);
  color: var(--color-accent-ink, #fff);
  border: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.approval-kbd {
  font-family: var(--font-mono);
  font-size: 9px;
  opacity: 0.7;
  font-weight: 400;
}

/* Entrance animation */
.approval-card {
  animation: approval-enter 150ms cubic-bezier(.4,0,.2,1) both;
}
@keyframes approval-enter {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
