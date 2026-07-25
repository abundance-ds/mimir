const encoder = new TextEncoder()

const ENDED = new Set(['done', 'error', 'stopped', 'interrupted'])

const STATUS_LABELS = {
  ready: 'Ready',
  starting: 'Starting',
  working: 'Working',
  'needs-input': 'Input',
  idle: 'Idle',
  done: 'Done',
  error: 'Error',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
}

export function terminalBytes(value) {
  if (typeof value === 'string') return encoder.encode(value)
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return Uint8Array.from(value || [])
}

export function isEndedStatus(status) {
  return ENDED.has(status)
}

export function terminalStatusLabel(status) {
  return STATUS_LABELS[status] || 'Unknown'
}

export function eventActivityId(event) {
  return event?.activityId || event?.activity_id || ''
}

export function orderedReplayChunks(snapshot) {
  return [...(snapshot?.scrollback?.chunks || [])]
    .filter((chunk) => Number.isFinite(Number(chunk?.sequence)))
    .sort((left, right) => Number(left.sequence) - Number(right.sequence))
}

export function readTerminalTheme(root = document.documentElement) {
  const styles = getComputedStyle(root)
  const token = (name, fallback) => styles.getPropertyValue(name).trim() || fallback
  const accent = token('--color-accent', '#c05d3c')
  const surface = token('--color-surface', '#ffffff')

  return {
    background: surface,
    foreground: token('--color-ink-2', '#4a4a44'),
    cursor: accent,
    cursorAccent: surface,
    selectionBackground: withAlpha(accent, '33'),
    black: token('--color-ink', '#1a1a18'),
    red: token('--color-rem', '#c05d3c'),
    green: token('--color-add', '#5e8b3e'),
    yellow: '#d4a520',
    blue: '#4a7c9b',
    magenta: '#7c4dff',
    cyan: '#5a9e8f',
    white: token('--color-rule', '#d8d7d2'),
    brightBlack: token('--color-ink-3', '#8a8a80'),
    brightRed: '#e07070',
    brightGreen: '#7cc68a',
    brightYellow: '#f0c040',
    brightBlue: '#6ea8c8',
    brightMagenta: '#b39dff',
    brightCyan: '#7cc6b8',
    brightWhite: token('--color-ink', '#1a1a18'),
  }
}

function withAlpha(color, alpha) {
  if (/^#[0-9a-f]{6}$/i.test(color)) return `${color}${alpha}`
  return color
}
